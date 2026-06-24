import { InstructionTrace } from "@dcorp80/z80cpu-debug";
import { describe, expect, it } from "vitest";
import { COLLAPSE_ENABLED, TraceRing } from "./traceRing.ts";

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
    r.push(mkTrace({ startAddr: 0x100, hc: 1 }), 10, false);
    r.push(mkTrace({ startAddr: 0x101, hc: 2 }), 20, false);
    r.push(mkTrace({ startAddr: 0x102, hc: 3 }), 30, false);
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
      false,
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
      r.push(mkTrace({ startAddr: 0x1000 + i, hc: i }), 10 * i, false);
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
    r.push(mkTrace({ startAddr: 0x100, hc: 1 }), 10, false);
    const recA = r.at(0);
    if (recA) recA.disasmText = "LD A,B";
    // Two more pushes wrap back to slot 0
    r.push(mkTrace({ startAddr: 0x101, hc: 2 }), 20, false);
    r.push(mkTrace({ startAddr: 0x102, hc: 3 }), 30, false);
    // The slot that held the first record now holds the third.
    expect(r.at(1)?.startAddr).toBe(0x102);
    expect(r.at(1)?.disasmText).toBeNull();
  });

  it("version bumps on every push and on clear", () => {
    const r = new TraceRing(2);
    expect(r.version()).toBe(0);
    r.push(mkTrace({}), 0, false);
    expect(r.version()).toBe(1);
    r.push(mkTrace({}), 1, false);
    expect(r.version()).toBe(2);
    r.clear();
    expect(r.version()).toBe(3);
    expect(r.size()).toBe(0);
    expect(r.at(0)).toBeUndefined();
  });

  it("findByHc returns latest record with hc <= target", () => {
    const r = new TraceRing(8);
    // HCs: 10, 20, 30, 40, 50
    for (let i = 1; i <= 5; i++) r.push(mkTrace({ hc: i }), i * 10, false);
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
    for (let i = 1; i <= 5; i++) r.push(mkTrace({ hc: i }), i * 10, false);
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
    r.push(mkTrace({ hc: 1 }), 10, false);
    r.push(mkTrace({ hc: 2 }), 20, false);
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.oldestHc()).toBeUndefined();
    expect(r.newestHc()).toBeUndefined();
    // Subsequent pushes start from slot 0 again.
    r.push(mkTrace({ hc: 99 }), 990, false);
    expect(r.size()).toBe(1);
    expect(r.at(0)?.hc).toBe(990);
  });
});

describe("TraceRing — collapse repeats", () => {
  it("COLLAPSE_ENABLED defaults to true", () => {
    expect(COLLAPSE_ENABLED).toBe(true);
  });

  it("same-PC run folds into one record with count and lastHc updated", () => {
    const r = new TraceRing(8);
    const t = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
      hc: 4,
    });
    r.push(t, 10, true);
    r.push(t, 20, true);
    r.push(t, 30, true);
    expect(r.size()).toBe(1);
    expect(r.at(0)?.count).toBe(3);
    expect(r.at(0)?.hc).toBe(10); // first iteration's HC
    expect(r.at(0)?.lastHc).toBe(30); // latest iteration's HC
  });

  it("version bumps on every push including folds", () => {
    const r = new TraceRing(8);
    const t = mkTrace({ startAddr: 0x1000, bytes: [0xed, 0xb0], length: 2 });
    r.push(t, 10, true);
    expect(r.version()).toBe(1);
    r.push(t, 20, true); // fold
    expect(r.version()).toBe(2);
    r.push(t, 30, true); // fold
    expect(r.version()).toBe(3);
  });

  it("new record starts with count=1 and lastHc=hc", () => {
    const r = new TraceRing(4);
    r.push(mkTrace({ startAddr: 0x100, bytes: [0x00], length: 1 }), 50, true);
    expect(r.at(0)?.count).toBe(1);
    expect(r.at(0)?.lastHc).toBe(50);
    expect(r.at(0)?.hc).toBe(50);
  });

  it("predicate: stale bytes beyond length are NOT compared (dbg double-buffer fix)", () => {
    // The dbg alternates two InstructionTrace buffers (_a/_b) and does NOT
    // clear slots beyond `length` between instructions. For a 1-byte HALT,
    // bytes[1..3] carry garbage from the previous longer instruction in
    // that buffer. Comparing those stale bytes would break the FIRST fold.
    // Predicate must only check bytes[0..length).
    const r = new TraceRing(4);
    const haltA = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76, 0xaa, 0xbb, 0xcc],
      length: 1,
      m1Type: "halt",
    });
    const haltB = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76, 0xdd, 0xee, 0xff],
      length: 1,
      m1Type: "halt",
    });
    r.push(haltA, 10, true); // first push — fresh record
    r.push(haltB, 20, true); // stale bytes[1..3] differ, but length=1 → should FOLD
    expect(r.size()).toBe(1);
    expect(r.at(0)?.count).toBe(2);
  });

  it("predicate: differing startAddr breaks the run", () => {
    const r = new TraceRing(4);
    r.push(mkTrace({ startAddr: 0x1000, bytes: [0x00], length: 1 }), 10, true);
    r.push(mkTrace({ startAddr: 0x1001, bytes: [0x00], length: 1 }), 20, true);
    expect(r.size()).toBe(2);
  });

  it("predicate: differing length breaks the run", () => {
    const r = new TraceRing(4);
    r.push(
      mkTrace({ startAddr: 0x1000, bytes: [0x01, 0x02], length: 2 }),
      10,
      true,
    );
    r.push(
      mkTrace({ startAddr: 0x1000, bytes: [0x01, 0x02], length: 1 }),
      20,
      true,
    );
    expect(r.size()).toBe(2);
  });

  it("predicate: differing bytes breaks the run", () => {
    const r = new TraceRing(4);
    r.push(
      mkTrace({ startAddr: 0x1000, bytes: [0xed, 0xb0], length: 2 }),
      10,
      true,
    );
    r.push(
      mkTrace({ startAddr: 0x1000, bytes: [0xed, 0xb8], length: 2 }),
      20,
      true,
    );
    expect(r.size()).toBe(2);
  });

  it("predicate: differing m1Type breaks the run (HALT exit on INT)", () => {
    const r = new TraceRing(4);
    r.push(
      mkTrace({ startAddr: 0x4000, bytes: [0x76], length: 1, m1Type: "halt" }),
      10,
      true,
    );
    r.push(
      mkTrace({ startAddr: 0x4000, bytes: [0x76], length: 1, m1Type: "int" }),
      20,
      true,
    );
    expect(r.size()).toBe(2);
    expect(r.at(0)?.count).toBe(1);
    expect(r.at(1)?.count).toBe(1);
  });

  it("collapse=false disables folding — each push is a fresh record", () => {
    const r = new TraceRing(8);
    const t = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
    });
    r.push(t, 10, false);
    r.push(t, 20, false);
    r.push(t, 30, false);
    expect(r.size()).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(r.at(i)?.count).toBe(1);
    }
  });

  it("collapse works across the ring wrap boundary", () => {
    // Cap of 3: fill it, then keep folding into the head record at wrap.
    const r = new TraceRing(3);
    const diffA = mkTrace({ startAddr: 0x1000, bytes: [0x01], length: 1 });
    const diffB = mkTrace({ startAddr: 0x1001, bytes: [0x02], length: 1 });
    const spin = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
    });
    r.push(diffA, 10, true);
    r.push(diffB, 20, true);
    r.push(spin, 30, true);
    // Ring is full: [diffA, diffB, spin], head wraps to slot 0.
    // Next push of spin folds — slot (head-1) = slot 2 = spin.
    r.push(spin, 40, true);
    expect(r.size()).toBe(3); // still 3 records (fold, no eviction)
    expect(r.at(2)?.startAddr).toBe(0x4000);
    expect(r.at(2)?.count).toBe(2);
    expect(r.at(2)?.lastHc).toBe(40);
  });

  it("clear resets count and lastHc on next use (recycled slots re-init on push)", () => {
    const r = new TraceRing(4);
    const t = mkTrace({
      startAddr: 0x100,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
    });
    r.push(t, 10, true);
    r.push(t, 20, true); // count=2
    r.clear();
    r.push(mkTrace({ startAddr: 0x200, bytes: [0x00], length: 1 }), 99, true);
    expect(r.at(0)?.count).toBe(1);
    expect(r.at(0)?.lastHc).toBe(99);
    expect(r.at(0)?.hc).toBe(99);
  });

  it("findByHc still keys on `hc` (first iteration) for folded records", () => {
    // Folded HALT spans HC 1000..5000; next instruction completes at 6000.
    // The binary search invariant is rec.hc <= target (rec.hc stays at the
    // FIRST iteration), so findByHc finds the folded record for any target
    // in [first.hc, next.hc - 1] — including HCs after the run ended.
    const r = new TraceRing(8);
    const halt = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
    });
    r.push(halt, 1000, true); // first iteration
    r.push(halt, 3000, true); // fold; lastHc = 3000
    r.push(halt, 5000, true); // fold; lastHc = 5000
    r.push(
      mkTrace({ startAddr: 0x4001, bytes: [0x00], length: 1 }),
      6000,
      true,
    );
    expect(r.size()).toBe(2);
    // Target before any record.
    expect(r.findByHc(500)).toBeUndefined();
    // Inside the folded run.
    expect(r.findByHc(1000)?.startAddr).toBe(0x4000);
    expect(r.findByHc(3500)?.startAddr).toBe(0x4000);
    // After lastHc but before the next record — still the folded record,
    // since rec.hc=1000 <= 5500 and the next record's hc=6000 > 5500.
    expect(r.findByHc(5500)?.startAddr).toBe(0x4000);
    // At/after the next record.
    expect(r.findByHc(6000)?.startAddr).toBe(0x4001);
    expect(r.findByHc(9999)?.startAddr).toBe(0x4001);
  });
});
