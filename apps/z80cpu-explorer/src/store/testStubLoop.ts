import type { InstructionTrace } from "@dcorp80/z80cpu-debug";
import type {
  PauseReason,
  RunLoop,
  RunStatus,
  Unsubscribe,
} from "../runloop/loop.ts";
import type { Breakpoint } from "./types.ts";

// Minimal in-memory RunLoop double for store tests. Tracks the latest
// command but doesn't drive any CPU; subscribers can be invoked manually.

export interface StubLoop extends RunLoop {
  // Test-only inspection / drive helpers.
  emitPause(r: PauseReason): void;
  emitInstruction(t: InstructionTrace): void;
  emitTick(hc: number): void;
  setHc(hc: number): void;
  setStatus(s: RunStatus): void;
  lastCmd: string | null;
  lastStepN: number;
  lastBreakpoints: ReadonlyArray<Breakpoint>;
  /** Number of times `setBreakpoints` was called. Lets tests distinguish
   *  "list still matches" from "list was actually re-pushed." */
  setBreakpointsCalls: number;
}

export function makeStubLoop(): StubLoop {
  let status: RunStatus = "paused";
  // Mirror the real loop's Float64Array HC slot so emitInstruction can
  // hand subscribers `hcBox` by reference (matching the production
  // `onInstruction(cb: (trace, hcBox: Float64Array) => void)` contract).
  const hcBox = new Float64Array(1);
  // Subscriber lists mirror the real loop: tombstone Arrays, not Sets.
  // The store's dispatch sites read these to validate event flow; using
  // Set here would mask any future regression that depends on the
  // production iteration semantics (indexed-for + null-skip).
  const pauseSubs: (((r: PauseReason) => void) | null)[] = [];
  const instructionSubs: (
    | ((t: InstructionTrace, hcBox: Float64Array) => void)
    | null
  )[] = [];
  const tickSubs: (((hc: number) => void) | null)[] = [];

  function removeSub<T>(arr: (T | null)[], cb: T): void {
    const i = arr.indexOf(cb);
    if (i >= 0) arr[i] = null;
  }

  const stub: StubLoop = {
    status: () => status,
    hc: () => hcBox[0],
    run() {
      stub.lastCmd = "run";
      status = "running";
    },
    pause() {
      stub.lastCmd = "pause";
      const wasRunning = status !== "paused";
      status = "paused";
      if (wasRunning) {
        const n = pauseSubs.length;
        for (let i = 0; i < n; i++) {
          const cb = pauseSubs[i];
          if (cb !== null) cb({ kind: "user" });
        }
      }
    },
    stepInstructions(n: number) {
      stub.lastCmd = "stepInstructions";
      stub.lastStepN = n;
      status = "stepping";
    },
    stepHC(n: number) {
      stub.lastCmd = "stepHC";
      stub.lastStepN = n;
      status = "stepping";
    },
    zeroHC() {
      stub.lastCmd = "zeroHC";
      hcBox[0] = 0;
    },
    setBreakpoints(bps) {
      // Snapshot rather than alias. The store passes `unwrap(breakpoints)`
      // — a reference to a SolidStore-backed array that mutates in place
      // — so capturing the reference would let test assertions on
      // `loop.lastBreakpoints` pass by coincidence (current state) even
      // when `setBreakpoints` was never called. A shallow copy of the
      // BPs is enough to prove the call happened with the expected list.
      stub.lastBreakpoints = bps.map((b) => ({ ...b }));
      stub.setBreakpointsCalls++;
    },
    onPause(cb): Unsubscribe {
      pauseSubs.push(cb);
      return () => removeSub(pauseSubs, cb);
    },
    onInstruction(cb): Unsubscribe {
      instructionSubs.push(cb);
      return () => removeSub(instructionSubs, cb);
    },
    onTick(cb): Unsubscribe {
      tickSubs.push(cb);
      return () => removeSub(tickSubs, cb);
    },
    emitPause(r) {
      status = "paused";
      const n = pauseSubs.length;
      for (let i = 0; i < n; i++) {
        const cb = pauseSubs[i];
        if (cb !== null) cb(r);
      }
    },
    emitInstruction(t) {
      const n = instructionSubs.length;
      for (let i = 0; i < n; i++) {
        const cb = instructionSubs[i];
        if (cb !== null) cb(t, hcBox);
      }
    },
    emitTick(h) {
      hcBox[0] = h;
      const n = tickSubs.length;
      for (let i = 0; i < n; i++) {
        const cb = tickSubs[i];
        if (cb !== null) cb(h);
      }
    },
    setHc(h) {
      hcBox[0] = h;
    },
    setStatus(s) {
      status = s;
    },
    lastCmd: null,
    lastStepN: 0,
    lastBreakpoints: [],
    setBreakpointsCalls: 0,
  };
  return stub;
}
