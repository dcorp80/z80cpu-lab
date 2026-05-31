import type { Z80Cpu } from "@dcorp80/z80cpu";
import type { InstructionTrace, Z80DebugContext } from "@dcorp80/z80cpu-debug";
import type { Breakpoint } from "../store/types.ts";
import { createBreakpointEvaluator } from "./breakpoints.ts";
import type { LoopConfig } from "./defaults.ts";

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
  /** Called once per edge, BEFORE `dbg.clockEdge()`. Owns mem/IO resolution. */
  busTick: () => void;
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
  const { cpu, dbg, busTick, config } = deps;
  const now = deps.now ?? defaultNow;
  const schedule = deps.schedule ?? defaultSchedule;
  const breakpoints = createBreakpointEvaluator();

  let status: RunStatus = "paused";
  let hc = 0;
  // Step state — when > 0, the loop is in 'stepping' mode and decrements
  // these as instructions complete / edges fire. When both fall to 0 the
  // loop pauses with `step-complete`.
  let stepInstructionsRemaining = 0;
  let stepHcRemaining = 0;

  const pauseSubs = new Set<(r: PauseReason) => void>();
  const instructionSubs = new Set<
    (t: InstructionTrace, hcAtComplete: number) => void
  >();
  const tickSubs = new Set<(hc: number) => void>();

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
    for (const cb of instructionSubs) cb(trace, hc);
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
    for (const cb of pauseSubs) cb(reason);
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
      // Per-edge work: bus resolution + CPU clock edge + hc bookkeeping.
      busTick();
      dbg.clockEdge();
      hc++;
      if (stepHcRemaining > 0) stepHcRemaining--;
      // Breakpoints take precedence over step-complete: when a user
      // steps N instructions and a BP fires at instruction M<N, the
      // BP pause reason is more informative than a generic
      // step-complete. HC-target also wins over a coincident step-N
      // landing on the same edge — same rationale, the explicit BP
      // intent beats the implicit step boundary.
      const bp = breakpoints.checkAfterEdge(cpu, hc);
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
    for (const cb of tickSubs) cb(hc);
  }

  return {
    status: () => status,
    hc: () => hc,
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
      hc = 0;
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
      pauseSubs.add(cb);
      return () => pauseSubs.delete(cb);
    },
    onInstruction(cb) {
      instructionSubs.add(cb);
      return () => instructionSubs.delete(cb);
    },
    onTick(cb) {
      tickSubs.add(cb);
      return () => tickSubs.delete(cb);
    },
    _tickFrameSync() {
      runFrame();
    },
  };
}

export { DEFAULT_LOOP_CONFIG, type LoopConfig } from "./defaults.ts";
