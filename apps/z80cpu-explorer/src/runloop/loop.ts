import type { Z80Cpu } from "@dcorp80/z80cpu";
import type { InstructionTrace, Z80DebugContext } from "@dcorp80/z80cpu-debug";
import type { LoopConfig } from "../config/defaults.ts";
import type { Breakpoint } from "../store/types.ts";
import { createBreakpointEvaluator } from "./breakpoints.ts";

export type RunStatus = "paused" | "running" | "stepping";

export type PauseReason =
  | { kind: "user" }
  | { kind: "step-complete" }
  | { kind: "pc-breakpoint"; pc: number; lo: number; hi: number }
  | { kind: "hc-target"; target: number };

export type Unsubscribe = () => void;

export interface RunLoop {
  status(): RunStatus;
  hc(): number;
  run(): void;
  pause(reason?: PauseReason): void;
  stepInstructions(n: number): void;
  stepHC(n: number): void;
  zeroHC(): void;
  /**
   * Replace the active breakpoint set. Called by the store on every
   * add / remove / toggle / edit. Disabled BPs are filtered inside
   * the evaluator; pass the full list straight through.
   */
  setBreakpoints(bps: ReadonlyArray<Breakpoint>): void;
  onPause(cb: (reason: PauseReason) => void): Unsubscribe;
  onInstruction(
    cb: (trace: InstructionTrace, hcAtComplete: number) => void,
  ): Unsubscribe;
  onTick(cb: (hc: number) => void): Unsubscribe;
  /**
   * Test hook — wakes the loop synchronously without going through the
   * scheduler. Production code never calls this.
   */
  _tickFrameSync?(): void;
}

/** Injectable scheduler — defaults to `requestAnimationFrame`. */
export type FrameScheduler = (cb: () => void) => void;

export interface RunLoopDeps {
  /**
   * Read once per edge by the breakpoint evaluator (`cpu.nextStep` to
   * gate PC-range checks on M1 entry; `cpu.regs.pc` for the fetch
   * address). The dbg still owns clock-edge dispatch — the loop never
   * mutates the CPU.
   */
  cpu: Z80Cpu;
  dbg: Z80DebugContext;
  /**
   * Called once per edge, BEFORE `dbg.clockEdge()`. Owns mem/IO
   * resolution (and in M8b, level-pin assertion onto cpu.bus).
   */
  preEdge: () => void;
  /**
   * Called once per edge, AFTER `dbg.clockEdge()` and AFTER `hc++`.
   * Owns HW-trace recording — samples `cpu.bus` (the state post-edge,
   * at the now-incremented HC) and hands the sample to the buffer.
   * Receives the loop's `Float64Array` HC box by reference so the
   * stamp flows to `HwTraceBuffer.record`'s `chunk.hcs[pos] = box[0]`
   * write as a pure typed-array copy, never materializing a
   * HeapNumber past V8's SMI range. Callees should read `hcBox[0]`
   * once into a local if they need to do arithmetic with it.
   */
  postEdge: (hcBox: Float64Array) => void;
  config: LoopConfig;
  /**
   * Wallclock source — defaults to `performance.now`. Tests inject a
   * deterministic clock that returns 0 so the budget never fires.
   */
  now?: () => number;
  /**
   * Frame scheduler — defaults to `requestAnimationFrame`. Tests pass a
   * no-op so frames only run when `_tickFrameSync()` is invoked.
   */
  schedule?: FrameScheduler;
}

const defaultSchedule: FrameScheduler =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);

const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

// Dbgs we've already wired a RunLoop onto. The dbg ships with a no-op
// default for `onInstructionComplete`, so a truthy check would always
// fire — track claims explicitly instead.
const CLAIMED_DBGS = new WeakSet<Z80DebugContext>();

export function createRunLoop(deps: RunLoopDeps): RunLoop {
  const { cpu, dbg, preEdge, postEdge, config } = deps;
  const now = deps.now ?? defaultNow;
  const schedule = deps.schedule ?? defaultSchedule;
  const breakpoints = createBreakpointEvaluator();

  let status: RunStatus = "paused";
  // HC counter is stored in a Float64Array slot rather than a closure
  // variable so it stays unboxed once it exceeds V8's SMI range (~2.1B
  // on 64-bit, ~52s of full-speed run at ~40M edges/sec). With a plain
  // `let hc = 0`, every increment past 2^31 allocates a fresh
  // HeapNumber (16B each → ~640 MB/sec of allocation), showing up as GC
  // sawtooth in the profiler. Float64Array slots hold exact integers up
  // to 2^53 (~225M s at full speed, decades).
  //
  // The box itself is also passed by reference to `postEdge` (which
  // forwards to `HwTraceBuffer.record`), so the stamp flows from
  // `++hcBox[0]` here straight into `chunk.hcs[pos] = hcBox[0]` as a
  // typed-array→typed-array copy — no number materialization on either
  // boundary. Internal hot-path comparisons (`breakpoints.checkAfterEdge`
  // and the external subscriber callbacks) still take `hc: number`; V8
  // inlines those tight call sites in steady state, but past SMI range
  // each call materializes a HeapNumber for the argument. Acceptable
  // because checkAfterEdge is monomorphic-inlineable, and the subscriber
  // callbacks fire at most ~10⁶/sec (insn) or ~60/sec (tick), not 40M.
  const hcBox = new Float64Array(1);
  // Step state — when > 0, the loop is in 'stepping' mode and decrements
  // these as instructions complete / edges fire. When both fall to 0 the
  // loop pauses with `step-complete`.
  let stepInstructionsRemaining = 0;
  let stepHcRemaining = 0;

  // Subscriber lists are plain Arrays with tombstone removal. Indexed
  // iteration stays allocation-free on the hot dispatch sites
  // (per-instruction ~10⁶/sec, per-frame tick). `for..of` over a Set
  // allocates a fresh iterator object per call — V8's escape analysis
  // on Set iterators is unreliable and surfaces as GC sawtooth in the
  // profiler.
  //
  // Mid-dispatch unsubscribe safety: a callback that calls its own
  // `off()` during dispatch would otherwise splice and shift the
  // remaining slots, causing the next callback to be skipped and a
  // read past the end. Instead, `removeSub` nulls the slot; the
  // dispatch loop's `cb !== null` guard skips tombstones, and the
  // captured `n` upper bound stays valid. Tombstones are compacted
  // lazily on the next `pushSub` (cold path, ~boot-time only) so the
  // array length doesn't grow unboundedly under sub/unsub churn.
  //
  // The Array form drops Set's dedupe-on-add: subscribing the same
  // callback twice now fires it twice. No production caller does that.
  const pauseSubs: (((r: PauseReason) => void) | null)[] = [];
  const instructionSubs: (((
    t: InstructionTrace,
    hcAtComplete: number,
  ) => void) | null)[] = [];
  const tickSubs: (((hc: number) => void) | null)[] = [];

  function pushSub<T>(arr: (T | null)[], cb: T): void {
    // Compact tombstones before pushing. Cold path — subscribe happens
    // at boot / on section mount, not on the per-edge hot path.
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] === null) arr.splice(i, 1);
    }
    arr.push(cb);
  }

  function removeSub<T>(arr: (T | null)[], cb: T): void {
    const i = arr.indexOf(cb);
    if (i >= 0) arr[i] = null;
  }

  // Bridge dbg's instruction-complete callback through to our subscribers
  // AND decrement the instruction step counter. The dbg only owns one
  // callback slot; we own it here so consumers go through the loop's
  // subscribe interface.
  if (CLAIMED_DBGS.has(dbg)) {
    // A second RunLoop against the same dbg would silently steal events
    // — surface it loudly at construction. Cold path, so unconditional.
    console.warn(
      "[runloop] this Z80DebugContext is already wired to another RunLoop; " +
        "instruction events will be redirected to the new one.",
    );
  }
  CLAIMED_DBGS.add(dbg);
  dbg.onInstructionComplete = (trace) => {
    if (stepInstructionsRemaining > 0) stepInstructionsRemaining--;
    const n = instructionSubs.length;
    const h = hcBox[0];
    for (let i = 0; i < n; i++) {
      const cb = instructionSubs[i];
      if (cb !== null) cb(trace, h);
    }
  };

  let frameScheduled = false;
  function scheduleFrame() {
    if (frameScheduled) return;
    if (status === "paused") return;
    frameScheduled = true;
    schedule(() => {
      frameScheduled = false;
      runFrame();
      // Chain — keep running until paused.
      if (status !== "paused") scheduleFrame();
    });
  }

  function firePause(reason: PauseReason): void {
    status = "paused";
    // Clear step counters on any pause path. A BP firing mid-step would
    // otherwise leave `stepInstructionsRemaining`/`stepHcRemaining`
    // non-zero — and a subsequent `run()` already clears them, but
    // `stepInstructions()` after a BP pause would clobber them safely too.
    // The redundancy is cheap and makes "pause for any reason zeros the
    // step state" a single-place invariant.
    stepInstructionsRemaining = 0;
    stepHcRemaining = 0;
    const n = pauseSubs.length;
    for (let i = 0; i < n; i++) {
      const cb = pauseSubs[i];
      if (cb !== null) cb(reason);
    }
  }

  function shouldStopForStep(): PauseReason | null {
    if (status !== "stepping") return null;
    const insnDone = stepInstructionsRemaining === 0;
    const hcDone = stepHcRemaining === 0;
    if (insnDone && hcDone) return { kind: "step-complete" };
    return null;
  }

  function runFrame(): void {
    if (status === "paused") return;
    const t0 = now();
    let edgeBudgetCheck = 0;
    // Both exit paths use explicit `break` (step-complete via firePause,
    // and the frame-budget cutoff). A `while (status !== "paused")` guard
    // would be dead defensive code — and TS narrows `status` past the
    // early-return above so the comparison reads as unreachable.
    while (true) {
      // Per-edge work: preEdge runs the bus resolver (and in M8b,
      // level-pin assertion) BEFORE clockEdge; postEdge runs the
      // HW-trace sampler AFTER clockEdge + hc++ so it captures the
      // post-edge state at the correct HC.
      preEdge();
      dbg.clockEdge();
      hcBox[0]++;
      postEdge(hcBox);
      if (stepHcRemaining > 0) stepHcRemaining--;
      // Breakpoints take precedence over step-complete: when a user
      // steps N instructions and a BP fires at instruction M<N, the
      // BP pause reason is more informative than a generic
      // step-complete. HC-target also wins over a coincident step-N
      // landing on the same edge — same rationale, the explicit BP
      // intent beats the implicit step boundary.
      const bp = breakpoints.checkAfterEdge(cpu, hcBox[0]);
      if (bp) {
        firePause(bp);
        break;
      }
      // Step completion is checked after every edge so sub-frame stops
      // (DESIGN §2.1 responsibility 6) land precisely on the target edge.
      const stop = shouldStopForStep();
      if (stop) {
        firePause(stop);
        break;
      }
      if (++edgeBudgetCheck >= config.budgetCheckEveryEdges) {
        edgeBudgetCheck = 0;
        if (now() - t0 > config.frameBudgetMs) break;
      }
    }
    const tn = tickSubs.length;
    const th = hcBox[0];
    for (let i = 0; i < tn; i++) {
      const cb = tickSubs[i];
      if (cb !== null) cb(th);
    }
  }

  return {
    status: () => status,
    hc: () => hcBox[0],
    run() {
      if (status === "running") return;
      status = "running";
      stepInstructionsRemaining = 0;
      stepHcRemaining = 0;
      scheduleFrame();
    },
    pause(reason: PauseReason = { kind: "user" }) {
      if (status === "paused") return;
      firePause(reason);
    },
    stepInstructions(n: number) {
      if (n <= 0) return;
      stepInstructionsRemaining = n;
      stepHcRemaining = 0;
      status = "stepping";
      scheduleFrame();
    },
    stepHC(n: number) {
      if (n <= 0) return;
      stepHcRemaining = n;
      stepInstructionsRemaining = 0;
      status = "stepping";
      scheduleFrame();
    },
    zeroHC() {
      // Counter resets; CPU/dbg state untouched (REQ §7.3). Time-stamped
      // buffer clearing is the store's job — the loop just zeros its own.
      hcBox[0] = 0;
      // Re-arm HC-count BPs so any target > 0 fires again post-zero. A
      // target ≤ 0 would refire on the next edge — not a special case,
      // just the natural fallout of "everything > -1 is eligible again".
      breakpoints.resetHcCutoff();
      // dbg's totalHc is independent (DESIGN §2.6) so we leave it alone.
    },
    setBreakpoints(bps) {
      breakpoints.setBreakpoints(bps);
    },
    onPause(cb) {
      pushSub(pauseSubs, cb);
      return () => removeSub(pauseSubs, cb);
    },
    onInstruction(cb) {
      pushSub(instructionSubs, cb);
      return () => removeSub(instructionSubs, cb);
    },
    onTick(cb) {
      pushSub(tickSubs, cb);
      return () => removeSub(tickSubs, cb);
    },
    _tickFrameSync() {
      runFrame();
    },
  };
}

export { DEFAULT_LOOP_CONFIG, type LoopConfig } from "../config/defaults.ts";
