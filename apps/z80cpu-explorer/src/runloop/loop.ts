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

/**
 * Read-only view over the loop's single-slot `Float64Array` HC counter.
 *
 * Subscribers can do `box[0]` reads (no HeapNumber materialization
 * inside V8's SMI range, then a typed-array → typed-array copy past it
 * — see `HwTraceBuffer.record`'s `_hcs[idx] = box[0]`), but cannot
 * write — TS rejects `box[0] = …` against the readonly index signature.
 * The runtime value is still the same `Float64Array`; this is a pure
 * compile-time guard with zero runtime cost (no Proxy, no copy, no
 * subarray view). It turns the existing "by convention, don't write to
 * this" comment into an enforceable contract for in-tree TS consumers.
 */
export interface ReadonlyHcBox {
  readonly [n: number]: number;
  readonly length: number;
}

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
    cb: (trace: InstructionTrace, hcBox: ReadonlyHcBox) => void,
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
   * stamp flows to `HwTraceBuffer.record`'s `_hcs[idx] = box[0]`
   * write as a pure typed-array copy, never materializing a
   * HeapNumber past V8's SMI range. Callees should read `hcBox[0]`
   * once into a local if they need to do arithmetic with it.
   */
  postEdge: (hcBox: ReadonlyHcBox) => void;
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
  // `++hcBox[0]` here straight into `_hcs[idx] = hcBox[0]` as a
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
  const instructionSubs: (
    | ((t: InstructionTrace, hcBox: ReadonlyHcBox) => void)
    | null
  )[] = [];
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
    for (let i = 0; i < n; i++) {
      const cb = instructionSubs[i];
      if (cb !== null) cb(trace, hcBox);
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
    // `<= 0` rather than `=== 0`: a non-integer N (e.g. 2.5) would
    // walk the counter through 0 to a negative residue (0.5 → -0.5),
    // and `=== 0` would never match. UI's `parsePositiveInt` already
    // floors at the input boundary, but this guard makes the
    // programmatic surface non-trappy too.
    const insnDone = stepInstructionsRemaining <= 0;
    const hcDone = stepHcRemaining <= 0;
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
      // Breakpoints never pause out of step mode — the step target is
      // the only pause boundary while stepping. Without this
      // gate, Step from a BP-paused state would refire the same BP on
      // the very next edge in many configurations (PC-range covering
      // the current PC, HC-count BP exactly at the current HC, BPs
      // landing inside the step window) and the user would see "press
      // Step → still paused at the same BP" with no apparent progress.
      // We still call `checkAfterEdge` so HC-count BPs encountered
      // during the step get their fired-flag set as a side effect — a
      // subsequent `run()` then correctly skips them rather than
      // immediately re-pausing at an HC the step already swept past.
      const bp = breakpoints.checkAfterEdge(cpu, hcBox[0]);
      if (bp && status !== "stepping") {
        firePause(bp);
        break;
      }
      // Step completion is checked after every edge so sub-frame stops
      // land precisely on the target edge.
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
      // Counter resets; CPU/dbg state untouched. Time-stamped
      // buffer clearing is the store's job — the loop just zeros its own.
      hcBox[0] = 0;
      // Re-arm HC-count BPs so any target > 0 fires again post-zero. A
      // target ≤ 0 would refire on the next edge — not a special case,
      // just the natural fallout of "everything > -1 is eligible again".
      breakpoints.resetHcCutoff();
      // dbg's totalHc is independent so we leave it alone.
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
