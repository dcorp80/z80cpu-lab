import { Z80Cpu } from "@dcorp80/z80cpu";
import { Z80DebugContext } from "@dcorp80/z80cpu-debug";
import { describe, expect, it, vi } from "vitest";
import { makeBus64k } from "./bus.ts";
import { DEFAULT_BUS_CONFIG } from "./defaults.ts";
import { createRunLoop, type PauseReason, type RunLoop } from "./loop.ts";

// Build a real CPU + dbg + bus. Force memInit=0 so the code path is
// NOPs (opcode 00 = NOP) — keeps step/HC arithmetic predictable instead
// of relying on whatever opcode the default fill (0xFF = RST 38h) implies.
// The loop is wired with a no-op scheduler so frames only fire when the
// test calls `_tickFrameSync()`. `now` returns 0 so the budget never bites;
// step targets are the only way the loop pauses.
function buildLoop() {
  const cpu = new Z80Cpu();
  const dbg = new Z80DebugContext(cpu);
  const bus = makeBus64k(cpu, { ...DEFAULT_BUS_CONFIG, memInit: 0 });
  const pauses: PauseReason[] = [];
  const insnHcs: number[] = [];
  const loop = createRunLoop({
    cpu,
    dbg,
    busTick: bus.resolve,
    config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1_000_000 },
    now: () => 0,
    schedule: () => {
      // No-op — tests drive frames via _tickFrameSync.
    },
  });
  loop.onPause((r) => pauses.push(r));
  loop.onInstruction((_t, hcAtComplete) => insnHcs.push(hcAtComplete));
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

  it("warns when a second RunLoop is built against the same dbg", () => {
    const cpu = new Z80Cpu();
    const dbg = new Z80DebugContext(cpu);
    const bus = makeBus64k(cpu, { ...DEFAULT_BUS_CONFIG, memInit: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createRunLoop({
      cpu,
      dbg,
      busTick: bus.resolve,
      config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1 },
      now: () => 0,
      schedule: () => {},
    });
    expect(warn).not.toHaveBeenCalled();
    createRunLoop({
      cpu,
      dbg,
      busTick: bus.resolve,
      config: { frameBudgetMs: 1, budgetCheckEveryEdges: 1 },
      now: () => 0,
      schedule: () => {},
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
