import { Z80Cpu } from "@dcorp80/z80cpu";
import { Z80DebugContext } from "@dcorp80/z80cpu-debug";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUS_CONFIG } from "../config/defaults.ts";
import { makeBus64k } from "./bus.ts";
import {
  createRunLoop,
  HC_BOX_LENGTH,
  type PauseReason,
  type ReadonlyHcBox,
  type RunLoop,
} from "./loop.ts";

const noopPostEdge = (_hcBox: ReadonlyHcBox): void => {};

// Build a real CPU + dbg + bus. Force memInit=0 so the code path is
// NOPs (opcode 00 = NOP) — keeps step/HC arithmetic predictable instead
// of relying on whatever opcode the default fill (0xFF = RST 38h) implies.
// The loop is wired with a no-op scheduler so frames only fire when the
// test calls `_tickFrameSync()`. `now` returns 0 so the budget never bites;
// step targets are the only way the loop pauses.
function buildLoop() {
  const cpu = new Z80Cpu();
  const dbg = new Z80DebugContext(cpu);
  const bus = makeBus64k(
    cpu,
    { ...DEFAULT_BUS_CONFIG, memInit: 0 },
    new Float64Array(HC_BOX_LENGTH),
  );
  const pauses: PauseReason[] = [];
  const insnHcs: number[] = [];
  const loop = createRunLoop({
    cpu,
    dbg,
    preEdge: bus.resolve,
    postEdge: noopPostEdge,
    config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1_000_000 },
    now: () => 0,
    schedule: () => {
      // No-op — tests drive frames via _tickFrameSync.
    },
  });
  loop.onPause((r) => pauses.push(r));
  // hcBox is the loop's Float64Array HC slot — copy the value out so the
  // assertion compares plain numbers (and so the captured HC stays
  // immutable in `insnHcs` even though the box keeps mutating).
  loop.onInstruction((_t, hcBox) => insnHcs.push(hcBox[0]));
  return { cpu, dbg, bus, loop, pauses, insnHcs };
}

const sync = (l: RunLoop) => {
  if (!l._tickFrameSync) throw new Error("loop missing sync hook");
  l._tickFrameSync();
};

describe("RunLoop", () => {
  it("starts paused at hc=0", () => {
    const { loop } = buildLoop();
    expect(loop.status()).toBe("paused");
    expect(loop.hc()).toBe(0);
  });

  it("stepInstructions(N) pauses after N completed instructions", () => {
    const { loop, pauses, insnHcs } = buildLoop();
    loop.stepInstructions(3);
    expect(loop.status()).toBe("stepping");
    sync(loop);
    expect(loop.status()).toBe("paused");
    expect(insnHcs.length).toBe(3);
    expect(pauses).toEqual([{ kind: "step-complete" }]);
  });

  it("stepHC(N) advances exactly N half-cycles", () => {
    const { loop, pauses } = buildLoop();
    loop.stepHC(7);
    sync(loop);
    expect(loop.hc()).toBe(7);
    expect(loop.status()).toBe("paused");
    expect(pauses).toEqual([{ kind: "step-complete" }]);
  });

  it("pause(reason) interrupts a step early", () => {
    const { loop } = buildLoop();
    loop.stepHC(1000);
    // Pause before driving any frames.
    loop.pause();
    expect(loop.status()).toBe("paused");
    sync(loop);
    // No HC advanced because the frame is short-circuited by the
    // paused status check at the top of runFrame.
    expect(loop.hc()).toBe(0);
  });

  it("zeroHC() resets the counter without disturbing the CPU", () => {
    const { loop, cpu } = buildLoop();
    loop.stepHC(10);
    sync(loop);
    expect(loop.hc()).toBe(10);
    const pcBefore = cpu.regs.pc;
    loop.zeroHC();
    expect(loop.hc()).toBe(0);
    expect(cpu.regs.pc).toBe(pcBefore);
  });

  it("ignores stepInstructions(0) and negative inputs", () => {
    const { loop } = buildLoop();
    loop.stepInstructions(0);
    expect(loop.status()).toBe("paused");
    loop.stepInstructions(-5);
    expect(loop.status()).toBe("paused");
  });

  it("run() then pause() does not re-fire pause when already paused", () => {
    const { loop, pauses } = buildLoop();
    loop.pause();
    expect(pauses.length).toBe(0);
    loop.stepHC(2);
    sync(loop);
    expect(pauses.length).toBe(1);
    loop.pause();
    // Already paused → no extra event.
    expect(pauses.length).toBe(1);
  });

  it("onInstruction is invoked with the loop's hc at callback time", () => {
    const { loop, insnHcs } = buildLoop();
    loop.stepInstructions(2);
    sync(loop);
    // hc at callback time monotonically grows.
    expect(insnHcs.length).toBe(2);
    expect(insnHcs[0]).toBeGreaterThan(0);
    expect(insnHcs[1]).toBeGreaterThan(insnHcs[0]);
  });

  it("unsubscribe stops events", () => {
    const { loop } = buildLoop();
    let count = 0;
    const off = loop.onInstruction(() => count++);
    loop.stepInstructions(2);
    sync(loop);
    expect(count).toBe(2);
    off();
    loop.stepInstructions(2);
    sync(loop);
    expect(count).toBe(2);
  });

  it("HC-count BP fires from run() and pauses with hc-target", () => {
    const { loop, pauses } = buildLoop();
    loop.setBreakpoints([
      { id: "hc1", kind: "hc-count", target: 5, enabled: true },
    ]);
    loop.run();
    sync(loop);
    expect(loop.hc()).toBe(5);
    expect(pauses).toEqual([{ kind: "hc-target", target: 5 }]);
  });

  it("BPs do not fire during stepHC — only the step target pauses", () => {
    const { loop, pauses } = buildLoop();
    // HC-count BP at 5; step over it to HC=10. The BP is silently
    // swept past and marked fired as a side effect of the per-edge
    // checkAfterEdge call.
    loop.setBreakpoints([
      { id: "hc1", kind: "hc-count", target: 5, enabled: true },
    ]);
    loop.stepHC(10);
    sync(loop);
    expect(loop.hc()).toBe(10);
    expect(pauses).toEqual([{ kind: "step-complete" }]);
    // Now run() — the BP was already marked fired during the step,
    // so it must not re-fire (no double-pause at the same HC).
    loop.run();
    expect(loop.status()).toBe("running");
    loop.pause();
  });

  it("PC-range BP fires when the CPU enters the range", () => {
    // memInit=0 so the program is all NOPs from $0000. A NOP at $0000
    // advances PC to $0001, the next M1 fetches at $0001, and our BP
    // at $0001 catches it.
    const { loop, pauses, cpu } = buildLoop();
    loop.setBreakpoints([
      { id: "pc1", kind: "pc-range", lo: 0x0001, hi: 0x0001, enabled: true },
    ]);
    loop.run();
    sync(loop);
    expect(loop.status()).toBe("paused");
    expect(pauses[0]?.kind).toBe("pc-breakpoint");
    expect(cpu.regs.pc).toBe(0x0001);
  });

  it("zeroHC re-arms a fired HC-count BP", () => {
    const { loop, pauses } = buildLoop();
    loop.setBreakpoints([
      { id: "hc1", kind: "hc-count", target: 3, enabled: true },
    ]);
    loop.run();
    sync(loop);
    expect(pauses.length).toBe(1);
    loop.zeroHC();
    loop.run();
    sync(loop);
    // BP re-armed by zeroHC, fired again at hc=3 from the new zero.
    expect(pauses.length).toBe(2);
    expect(loop.hc()).toBe(3);
  });

  it("step-complete wins over a coincident BP that lands on the step target", () => {
    const { loop, pauses } = buildLoop();
    loop.setBreakpoints([
      { id: "hc1", kind: "hc-count", target: 5, enabled: true },
    ]);
    loop.stepHC(5);
    sync(loop);
    // Both would land on edge 5; in step mode BPs are suppressed, so
    // the explicit step boundary is the only pause reason. (Pre-§12
    // behavior was the opposite — BPs took precedence.)
    expect(pauses).toEqual([{ kind: "step-complete" }]);
  });

  it("PC-range BP does not refire when stepping out of a BP pause", () => {
    // Reproduces the §12 issue: pause at a single-PC BP, click Step,
    // expect Step to actually advance an instruction rather than
    // re-pausing at the same BP. memInit=0 → all NOPs, so PC advances
    // by 1 per instruction.
    const { loop, pauses, cpu } = buildLoop();
    loop.setBreakpoints([
      { id: "pc1", kind: "pc-range", lo: 0x0001, hi: 0x0001, enabled: true },
    ]);
    loop.run();
    sync(loop);
    expect(pauses[0]?.kind).toBe("pc-breakpoint");
    expect(cpu.regs.pc).toBe(0x0001);
    // Now Step. Pre-fix behavior re-fired the BP on the first M1
    // entry of the resumed run; with the gate in place, the step
    // advances past it.
    loop.stepInstructions(1);
    sync(loop);
    expect(pauses.length).toBe(2);
    expect(pauses[1]).toEqual({ kind: "step-complete" });
    expect(cpu.regs.pc).toBeGreaterThan(0x0001);
  });

  describe("preEdge / postEdge ordering", () => {
    it("calls preEdge before clockEdge and postEdge after, once per HC", () => {
      const cpu = new Z80Cpu();
      const dbg = new Z80DebugContext(cpu);
      const bus = makeBus64k(
        cpu,
        { ...DEFAULT_BUS_CONFIG, memInit: 0 },
        new Float64Array(HC_BOX_LENGTH),
      );
      const calls: string[] = [];
      const preEdge = (): void => {
        calls.push("pre");
        bus.resolve();
      };
      const postEdge = (hcBox: ReadonlyHcBox): void => {
        calls.push(`post:${hcBox[0]}`);
      };
      const loop = createRunLoop({
        cpu,
        dbg,
        preEdge,
        postEdge,
        config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1_000_000 },
        now: () => 0,
        schedule: () => {},
      });
      loop.stepHC(3);
      sync(loop);
      expect(calls).toEqual([
        "pre",
        "post:1",
        "pre",
        "post:2",
        "pre",
        "post:3",
      ]);
    });
  });

  it("warns when a second RunLoop is built against the same dbg", () => {
    const cpu = new Z80Cpu();
    const dbg = new Z80DebugContext(cpu);
    const bus = makeBus64k(
      cpu,
      { ...DEFAULT_BUS_CONFIG, memInit: 0 },
      new Float64Array(HC_BOX_LENGTH),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createRunLoop({
      cpu,
      dbg,
      preEdge: bus.resolve,
      postEdge: noopPostEdge,
      config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1 },
      now: () => 0,
      schedule: () => {},
    });
    expect(warn).not.toHaveBeenCalled();
    createRunLoop({
      cpu,
      dbg,
      preEdge: bus.resolve,
      postEdge: noopPostEdge,
      config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1 },
      now: () => 0,
      schedule: () => {},
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  // Compile-time guard for #4: subscribers receive the HC slot as a
  // `ReadonlyHcBox`, so any accidental `box[0] = …` (which would have
  // corrupted the loop's authoritative counter) is a TS error. The
  // guard is TS-only; underneath, the value is still a mutable
  // Float64Array, so we never call this lambda — the `@ts-expect-error`
  // does the work at build time, and the build fails if the readonly
  // assignment ever stops being an error.
  it("ReadonlyHcBox rejects writes at the TS layer", () => {
    const _typecheck = (box: ReadonlyHcBox): void => {
      // @ts-expect-error — index signature is readonly, write rejected.
      box[0] = 5;
    };
    expect(typeof _typecheck).toBe("function");
  });
});
