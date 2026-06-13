// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

import { strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type HcCounter,
  Z80Breakpoints,
  Z80DebugContext,
} from "@dcorp80/z80cpu-debug";
import { makeBus, Z80Cpu } from "./test-utils.ts";

// Build a fresh (cpu, dbg, bp, hcBox, tick) harness. The HC counter is
// the consumer's responsibility — `tick()` ticks it explicitly after
// `dbg.clockEdge()` and then runs `bp.tickAfterEdge()`, matching the
// production wiring pattern.
function harness(mem?: Uint8Array) {
  const cpu = new Z80Cpu();
  const _mem = mem ?? new Uint8Array(256); // default: all NOPs
  const resolve = makeBus(cpu, _mem);
  const dbg = new Z80DebugContext(cpu);
  const hcBox = new Float64Array(1);
  const hc: HcCounter = { box: hcBox, index: 0 };
  const bp = new Z80Breakpoints(dbg, hc);

  const tick = (): void => {
    resolve();
    dbg.clockEdge();
    hcBox[0]++;
    bp.tickAfterEdge();
  };
  const tickN = (n: number): void => {
    for (let i = 0; i < n; i++) tick();
  };
  return { cpu, mem: _mem, dbg, bp, hcBox, hc, tick, tickN };
}

describe("Z80Breakpoints — stepHc", () => {
  test("stepHc(n, cb) fires cb after exactly n HC", () => {
    const h = harness();
    const startHc = h.hcBox[0];
    let fired = false;
    let firedAtHc = -1;
    h.bp.stepHc(50, () => {
      fired = true;
      firedAtHc = h.hcBox[0];
    });

    for (let i = 0; i < 200 && !fired; i++) h.tick();

    strictEqual(fired, true, "cb must fire");
    strictEqual(firedAtHc, startHc + 50, "cb fires exactly at startHc + n");
  });

  test("stepHc prefetch enables tracing before fire even if dbg was off", () => {
    const h = harness();
    h.dbg.enabled = false;

    const completed: number[] = [];
    h.dbg.onInstructionComplete = (t) => {
      completed.push(t.startAddr);
    };

    let fired = false;
    h.bp.stepHc(500, () => {
      fired = true;
    });

    for (let i = 0; i < 600 && !fired; i++) h.tick();

    strictEqual(fired, true, "cb fires");
    strictEqual(h.dbg.enabled, true, "prefetch must have flipped enabled true");
    // 96 HC prefetch / 8 HC per NOP ≈ at least a few traces before fire.
    strictEqual(
      completed.length >= 2,
      true,
      `expected ≥2 traces in prefetch window, got ${completed.length}`,
    );
  });

  test("stepHc(1, cb) — tight step works (smaller than prefetch)", () => {
    const h = harness();
    h.dbg.enabled = false;

    const startHc = h.hcBox[0];
    let firedAtHc = -1;
    // n=1 with default prefetch=96: enableAt = startHc + 1 - 96 < startHc,
    // so enable must flip immediately.
    h.bp.stepHc(1, () => {
      firedAtHc = h.hcBox[0];
    });

    strictEqual(h.dbg.enabled, true, "tight step enables immediately");

    for (let i = 0; i < 5 && firedAtHc < 0; i++) h.tick();
    strictEqual(firedAtHc, startHc + 1);
  });

  test("stepHc called twice replaces the pending callback", () => {
    const h = harness();
    let firstFired = 0;
    let secondFired = 0;
    h.bp.stepHc(100, () => {
      firstFired++;
    });
    h.bp.stepHc(50, () => {
      secondFired++;
    });

    for (let i = 0; i < 200; i++) h.tick();

    strictEqual(firstFired, 0, "replaced cb must NOT fire");
    strictEqual(secondFired, 1, "new cb fires exactly once");
  });

  test("stepHc(0, ...) throws", () => {
    const h = harness();
    let threw = false;
    try {
      h.bp.stepHc(0, () => {});
    } catch {
      threw = true;
    }
    strictEqual(threw, true);
  });

  // Regression: a stepHc armed but not yet fired must not survive into a
  // later disabled-mode tick loop. The prefetch enableAt would otherwise
  // force-enable dbg partway through, leaking traces. cancelStepHc lets
  // callers clean up the leftover when they exit their loop via another
  // condition.
  test("cancelStepHc disarms pending stepHc + prefetch enable", () => {
    const h = harness();

    let fired = false;
    h.bp.stepHc(500, () => {
      fired = true;
    });
    h.bp.cancelStepHc();

    h.dbg.enabled = false;
    const completed: number[] = [];
    h.dbg.onInstructionComplete = () => {
      completed.push(0);
    };
    h.tickN(1000);

    strictEqual(fired, false, "cancelled stepHc must not fire");
    strictEqual(
      h.dbg.enabled,
      false,
      "cancelled stepHc must not have force-enabled dbg",
    );
    strictEqual(
      completed.length,
      0,
      "no traces should leak through disabled mode",
    );
  });
});

describe("Z80Breakpoints — PC breakpoints", () => {
  test("single-address bp fires at PC = addr", () => {
    // NOP at 0..3, then a NOP at 4 — we want the bp at 0x0004 to fire
    // when the CPU reaches it.
    const h = harness();
    let hits = 0;
    let lastInfo: { pc: number; lo: number; hi: number } | null = null;
    h.bp.addPcBreak(0x0004, 0x0004, (info) => {
      hits++;
      lastInfo = info;
    });
    // 4 NOPs * 8 HC = 32 HC reaches PC=4. Give some margin.
    h.tickN(40);
    strictEqual(hits, 1, "single-address bp fires once when PC reaches addr");
    strictEqual(lastInfo?.pc, 0x0004);
    strictEqual(lastInfo?.lo, 0x0004);
    strictEqual(lastInfo?.hi, 0x0004);
  });

  test("range bp fires for every PC in [lo,hi]", () => {
    const h = harness();
    const hits: number[] = [];
    h.bp.addPcBreak(0x0002, 0x0004, (info) => {
      hits.push(info.pc);
    });
    // 5 NOPs * 8 HC = 40 HC; we should see PCs 2,3,4 (three fires).
    h.tickN(50);
    strictEqual(hits.length, 3, `expected 3 hits, got ${hits.length}`);
    strictEqual(hits[0], 0x0002);
    strictEqual(hits[1], 0x0003);
    strictEqual(hits[2], 0x0004);
  });

  test("addPcBreak with lo > hi throws", () => {
    const h = harness();
    let threw = false;
    try {
      h.bp.addPcBreak(0x0005, 0x0001, () => {});
    } catch {
      threw = true;
    }
    strictEqual(threw, true);
  });

  test("BreakHandle.remove() disarms the bp", () => {
    const h = harness();
    let hits = 0;
    const handle = h.bp.addPcBreak(0x0004, 0x0004, () => {
      hits++;
    });
    h.tickN(20); // PC has not reached 0x0004 yet (only 20 HC = ~2 NOPs)
    handle.remove();
    h.tickN(40); // now well past 0x0004
    strictEqual(hits, 0, "removed bp must never fire");
  });

  test("BreakHandle.remove() is idempotent", () => {
    const h = harness();
    const handle = h.bp.addPcBreak(0x0004, 0x0004, () => {});
    handle.remove();
    handle.remove(); // must not throw or corrupt state
    // Add another bp afterwards to verify the registry is still healthy.
    let hits = 0;
    h.bp.addPcBreak(0x0004, 0x0004, () => {
      hits++;
    });
    h.tickN(40);
    strictEqual(hits, 1);
  });

  test("clearAllPcBreaks disarms every registered bp", () => {
    const h = harness();
    let aHits = 0;
    let bHits = 0;
    h.bp.addPcBreak(0x0002, 0x0002, () => {
      aHits++;
    });
    h.bp.addPcBreak(0x0004, 0x0004, () => {
      bHits++;
    });
    h.bp.clearAllPcBreaks();
    h.tickN(60);
    strictEqual(aHits, 0);
    strictEqual(bHits, 0);
  });

  test("listPcBreaks reflects registered ranges", () => {
    const h = harness();
    h.bp.addPcBreak(0x0001, 0x0001, () => {});
    h.bp.addPcBreak(0x0100, 0x01ff, () => {});
    const list = h.bp.listPcBreaks();
    strictEqual(list.length, 2);
    strictEqual(list[0].lo, 0x0001);
    strictEqual(list[0].hi, 0x0001);
    strictEqual(list[1].lo, 0x0100);
    strictEqual(list[1].hi, 0x01ff);
  });

  test("PC bp force-enables dbg on hit", () => {
    const h = harness();
    h.dbg.enabled = false;
    let hits = 0;
    h.bp.addPcBreak(0x0002, 0x0002, () => {
      hits++;
    });
    h.tickN(40);
    strictEqual(hits, 1, "bp still fires while dbg was disabled");
    strictEqual(h.dbg.enabled, true, "bp hit must force-enable dbg");
  });

  test("multiple bps in same range all fire", () => {
    const h = harness();
    let aHits = 0;
    let bHits = 0;
    h.bp.addPcBreak(0x0002, 0x0002, () => {
      aHits++;
    });
    h.bp.addPcBreak(0x0002, 0x0002, () => {
      bHits++;
    });
    h.tickN(30);
    strictEqual(aHits, 1);
    strictEqual(bHits, 1);
  });
});
