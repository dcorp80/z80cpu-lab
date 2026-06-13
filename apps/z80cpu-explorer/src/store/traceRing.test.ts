import { InstructionTrace } from "@dcorp80/z80cpu-debug";
import { describe, expect, it } from "vitest";
import { TraceRing } from "./traceRing.ts";

function mkTrace(opts: {
  startAddr?: number;
  bytes?: number[];
  length?: number;
  m1Type?: InstructionTrace["m1Type"];
  hc?: number;
  nextPc?: number;
}): InstructionTrace {
  const t = new InstructionTrace();
  t.startAddr = opts.startAddr ?? 0;
  const src = opts.bytes ?? [];
  for (let i = 0; i < src.length; i++) t.bytes[i] = src[i];
  t.length = opts.length ?? src.length;
  t.m1Type = opts.m1Type ?? "normal";
  t.hc = opts.hc ?? 0;
  t.nextPc = opts.nextPc ?? 0;
  return t;
}

describe("TraceRing", () => {
  it("rejects non-positive capacity", () => {
    expect(() => new TraceRing(0)).toThrow(RangeError);
    expect(() => new TraceRing(-3)).toThrow(RangeError);
    expect(() => new TraceRing(1.5)).toThrow(RangeError);
  });

  it("is empty at construction", () => {
    const r = new TraceRing(4);
    expect(r.size()).toBe(0);
    expect(r.at(0)).toBeUndefined();
    expect(r.oldestHc()).toBeUndefined();
    expect(r.newestHc()).toBeUndefined();
    expect(r.findByHc(0)).toBeUndefined();
    expect(r.version()).toBe(0);
  });

  it("push fills slots in order, oldest-first view matches insert order", () => {
    const r = new TraceRing(4);
    r.push(mkTrace({ startAddr: 0x100, hc: 1 }), 10);
    r.push(mkTrace({ startAddr: 0x101, hc: 2 }), 20);
    r.push(mkTrace({ startAddr: 0x102, hc: 3 }), 30);
    expect(r.size()).toBe(3);
    expect(r.at(0)?.startAddr).toBe(0x100);
    expect(r.at(1)?.startAddr).toBe(0x101);
    expect(r.at(2)?.startAddr).toBe(0x102);
    expect(r.at(0)?.hc).toBe(10);
    expect(r.at(2)?.hc).toBe(30);
    expect(r.oldestHc()).toBe(10);
    expect(r.newestHc()).toBe(30);
    expect(r.version()).toBe(3);
  });

  it("copies bytes, length, m1Type, nextPc, instHc into the record", () => {
    const r = new TraceRing(2);
    r.push(
      mkTrace({
        startAddr: 0x1234,
        bytes: [0xdd, 0xcb, 0x05, 0x06],
        length: 4,
        m1Type: "normal",
        hc: 16,
        nextPc: 0x1238,
      }),
      100,
    );
    const rec = r.at(0);
    expect(rec).toBeDefined();
    expect(rec?.startAddr).toBe(0x1234);
    expect(rec?.bytes).toEqual([0xdd, 0xcb, 0x05, 0x06]);
    expect(rec?.length).toBe(4);
    expect(rec?.m1Type).toBe("normal");
    expect(rec?.nextPc).toBe(0x1238);
    expect(rec?.instHc).toBe(16);
    expect(rec?.hc).toBe(100);
    expect(rec?.disasmText).toBeNull();
  });

  it("wraps in place after `cap` pushes — oldest slot is overwritten", () => {
    const r = new TraceRing(3);
    for (let i = 0; i < 5; i++) {
      r.push(mkTrace({ startAddr: 0x1000 + i, hc: i }), 10 * i);
    }
    expect(r.size()).toBe(3);
    // The two oldest (i=0, i=1) were overwritten; what remains is i=2..4
    expect(r.at(0)?.startAddr).toBe(0x1002);
    expect(r.at(1)?.startAddr).toBe(0x1003);
    expect(r.at(2)?.startAddr).toBe(0x1004);
    expect(r.oldestHc()).toBe(20);
    expect(r.newestHc()).toBe(40);
  });

  it("clears disasmText on slot reuse", () => {
    const r = new TraceRing(2);
    r.push(mkTrace({ startAddr: 0x100, hc: 1 }), 10);
    const recA = r.at(0);
    if (recA) recA.disasmText = "LD A,B";
    // Two more pushes wrap back to slot 0
    r.push(mkTrace({ startAddr: 0x101, hc: 2 }), 20);
    r.push(mkTrace({ startAddr: 0x102, hc: 3 }), 30);
    // The slot that held the first record now holds the third.
    expect(r.at(1)?.startAddr).toBe(0x102);
    expect(r.at(1)?.disasmText).toBeNull();
  });

  it("version bumps on every push and on clear", () => {
    const r = new TraceRing(2);
    expect(r.version()).toBe(0);
    r.push(mkTrace({}), 0);
    expect(r.version()).toBe(1);
    r.push(mkTrace({}), 1);
    expect(r.version()).toBe(2);
    r.clear();
    expect(r.version()).toBe(3);
    expect(r.size()).toBe(0);
    expect(r.at(0)).toBeUndefined();
  });

  it("findByHc returns latest record with hc <= target", () => {
    const r = new TraceRing(8);
    // HCs: 10, 20, 30, 40, 50
    for (let i = 1; i <= 5; i++) r.push(mkTrace({ hc: i }), i * 10);
    expect(r.findByHc(9)).toBeUndefined();
    expect(r.findByHc(10)?.hc).toBe(10);
    expect(r.findByHc(15)?.hc).toBe(10);
    expect(r.findByHc(20)?.hc).toBe(20);
    expect(r.findByHc(35)?.hc).toBe(30);
    expect(r.findByHc(50)?.hc).toBe(50);
    expect(r.findByHc(1_000_000)?.hc).toBe(50);
  });

  it("findByHc works across the wrap boundary", () => {
    const r = new TraceRing(3);
    // Push five times: oldest extant has hc=30 (was the 3rd push).
    for (let i = 1; i <= 5; i++) r.push(mkTrace({ hc: i }), i * 10);
    // Extant HCs are 30, 40, 50 (in oldest-first order).
    expect(r.oldestHc()).toBe(30);
    expect(r.newestHc()).toBe(50);
    expect(r.findByHc(25)).toBeUndefined();
    expect(r.findByHc(30)?.hc).toBe(30);
    expect(r.findByHc(45)?.hc).toBe(40);
    expect(r.findByHc(99)?.hc).toBe(50);
  });

  it("clear resets size, head, and oldest/newest", () => {
    const r = new TraceRing(4);
    r.push(mkTrace({ hc: 1 }), 10);
    r.push(mkTrace({ hc: 2 }), 20);
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.oldestHc()).toBeUndefined();
    expect(r.newestHc()).toBeUndefined();
    // Subsequent pushes start from slot 0 again.
    r.push(mkTrace({ hc: 99 }), 990);
    expect(r.size()).toBe(1);
    expect(r.at(0)?.hc).toBe(990);
  });
});
