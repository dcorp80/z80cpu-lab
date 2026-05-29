import type {
  InstructionTrace,
  PauseReason,
  RunLoop,
  RunStatus,
  Unsubscribe,
} from "../runloop/loop.ts";

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
}

export function makeStubLoop(): StubLoop {
  let status: RunStatus = "paused";
  let hc = 0;
  const pauseSubs = new Set<(r: PauseReason) => void>();
  const instructionSubs = new Set<
    (t: InstructionTrace, hcAtComplete: number) => void
  >();
  const tickSubs = new Set<(hc: number) => void>();

  const stub: StubLoop = {
    status: () => status,
    hc: () => hc,
    run() {
      stub.lastCmd = "run";
      status = "running";
    },
    pause() {
      stub.lastCmd = "pause";
      const wasRunning = status !== "paused";
      status = "paused";
      if (wasRunning) for (const cb of pauseSubs) cb({ kind: "user" });
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
      hc = 0;
    },
    onPause(cb): Unsubscribe {
      pauseSubs.add(cb);
      return () => pauseSubs.delete(cb);
    },
    onInstruction(cb): Unsubscribe {
      instructionSubs.add(cb);
      return () => instructionSubs.delete(cb);
    },
    onTick(cb): Unsubscribe {
      tickSubs.add(cb);
      return () => tickSubs.delete(cb);
    },
    emitPause(r) {
      status = "paused";
      for (const cb of pauseSubs) cb(r);
    },
    emitInstruction(t) {
      for (const cb of instructionSubs) cb(t, hc);
    },
    emitTick(h) {
      hc = h;
      for (const cb of tickSubs) cb(h);
    },
    setHc(h) {
      hc = h;
    },
    setStatus(s) {
      status = s;
    },
    lastCmd: null,
    lastStepN: 0,
  };
  return stub;
}
