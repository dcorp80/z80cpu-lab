// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decodeFlags,
  type InstructionTrace,
  type M1Type,
  Z80DebugContext,
} from "@dcorp80/z80cpu-debug";
import { A, hex8, makeBus, preamble, Z80Cpu } from "./test-utils.ts";

function dbgTick(dbg: Z80DebugContext, resolve: () => void) {
  resolve();
  dbg.clockEdge();
}

function dbgTickN(dbg: Z80DebugContext, resolve: () => void, n: number) {
  for (let i = 0; i < n; i++) dbgTick(dbg, resolve);
}

function traceBytes(t: InstructionTrace): number[] {
  return t.bytes.slice(0, t.length);
}

describe("Z80DebugContext", () => {
  test("NOP: 4T, bytes=[00]", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x00; // NOP
    mem[1] = 0x00; // NOP (triggers commit of first NOP)
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; tStates: number; m1Type: M1Type }[] =
      [];
    dbg.onInstructionComplete = (t) => {
      completed.push({
        bytes: traceBytes(t),
        tStates: t.hc >> 1,
        m1Type: t.m1Type,
      });
    };

    // NOP(8 HC) + NOP(8 HC) = 16 HC
    dbgTickN(dbg, resolve, 16);

    strictEqual(completed.length, 1, "one instruction completed");
    deepStrictEqual(completed[0].bytes, [0x00]);
    strictEqual(completed[0].tStates, 4);
    strictEqual(completed[0].m1Type, "normal");
  });

  test("LD A,n: 7T, bytes=[3E, 42]", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x3e; // LD A,0x42
    mem[1] = 0x42;
    mem[2] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; tStates: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({ bytes: traceBytes(t), tStates: t.hc >> 1 });
    };

    // LD A,n: M1(8) + opRd(6) = 14 HC, NOP: 8 HC → total 22
    dbgTickN(dbg, resolve, 22);

    strictEqual(completed.length, 1);
    deepStrictEqual(completed[0].bytes, [0x3e, 0x42]);
    strictEqual(completed[0].tStates, 7);

    // A should be committed by now (deferred write landed at NOP's M1 T2)
    strictEqual(cpu.regs.file[A], 0x42, `A=${hex8(cpu.regs.file[A])}`);
  });

  test("committed state available at callback time", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x3e; // LD A,0x42
    mem[1] = 0x42;
    mem[2] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    let aAtCallback = -1;
    dbg.onInstructionComplete = () => {
      aAtCallback = cpu.regs.file[A];
    };

    // LD A,n(14 HC) + enough of NOP to trigger commit (M1 T3↓ = 6 HC into NOP)
    dbgTickN(dbg, resolve, 22);

    strictEqual(aAtCallback, 0x42, "A committed before callback fires");
  });

  test("DD-prefixed instruction accumulates bytes", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0xdd; // IX prefix
    mem[1] = 0x21; // LD IX,nn
    mem[2] = 0x34; // low byte
    mem[3] = 0x12; // high byte
    mem[4] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; tStates: number; addr: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({
        bytes: traceBytes(t),
        tStates: t.hc >> 1,
        addr: t.startAddr,
      });
    };

    // DD(8) + LD IX,nn: M1(8) + opRd(6) + opRd(6) = 20 HC, NOP(8) → total 36
    dbgTickN(dbg, resolve, 42);

    strictEqual(
      completed.length >= 1,
      true,
      `got ${completed.length} completions`,
    );
    deepStrictEqual(completed[0].bytes, [0xdd, 0x21, 0x34, 0x12]);
    strictEqual(completed[0].addr, 0, "startAddr is PC of DD prefix");
  });

  test("startAddr tracks instruction PC", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x00; // NOP at 0x0000
    mem[1] = 0x3e; // LD A,n at 0x0001
    mem[2] = 0xff;
    mem[3] = 0x00; // NOP at 0x0003
    mem[4] = 0x00; // NOP at 0x0004 (for final commit)
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const addrs: number[] = [];
    dbg.onInstructionComplete = (t) => {
      addrs.push(t.startAddr);
    };

    // NOP(8) + LD A,n(14) + NOP(8) + NOP(8) = 38
    dbgTickN(dbg, resolve, 38);

    strictEqual(addrs.length >= 2, true, `got ${addrs.length} completions`);
    strictEqual(addrs[0], 0x0000, "first NOP at 0x0000");
    strictEqual(addrs[1], 0x0001, "LD A,n at 0x0001");
  });

  test("mRd data bytes are NOT recorded in trace", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    const { p, hc } = preamble(mem, { h: 0x00, l: 0x50 });
    mem[p] = 0x7e; // LD A,(HL)
    mem[p + 1] = 0x00; // NOP
    mem[0x50] = 0xab; // data at (HL)

    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    // Burn through preamble + M1 T3 falling of next instruction (6 HC)
    // so the last preamble instruction's complete callback fires before we attach
    dbgTickN(dbg, resolve, hc + 6);

    const completed: number[][] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push(traceBytes(t));
    };

    // Remaining LD A,(HL): M1(8-6=2) + mRd(6) = 8, NOP(8) → 16
    dbgTickN(dbg, resolve, 16);

    strictEqual(completed.length, 1);
    deepStrictEqual(completed[0], [0x7e], "only opcode, not the mRd data byte");
  });

  test("ED-prefixed instruction accumulates bytes", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0xed; // ED prefix
    mem[1] = 0x57; // LD A,I
    mem[2] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: number[][] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push(traceBytes(t));
    };

    // ED(8) + LD A,I: M1(8) + internal(2) = 10, NOP(8) → total needs some room
    dbgTickN(dbg, resolve, 30);

    strictEqual(completed.length >= 1, true);
    deepStrictEqual(completed[0], [0xed, 0x57]);
  });

  // DD/FD/ED occupy the same one-slot prefix latch on real hardware:
  // successive DD/FD overwrite each other (each wasted prefix is still a
  // real 4T M1 cycle), and an ED resets the DD/FD latch. dbg surfaces this
  // as a separate trace per wasted M1 so the debugger sees each cycle the
  // chip actually executed.
  test("DD FD DD FD 21 nn nn → 4 traces (3 wasted + LD IY,nn)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0xdd; // wasted
    mem[1] = 0xfd; // wasted
    mem[2] = 0xdd; // wasted
    mem[3] = 0xfd; // effective: use IY
    mem[4] = 0x21; // LD IY,nn
    mem[5] = 0x34;
    mem[6] = 0x12;
    mem[7] = 0x00; // NOP — triggers commit of last trace
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; tStates: number; addr: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({
        bytes: traceBytes(t),
        tStates: t.hc >> 1,
        addr: t.startAddr,
      });
    };

    // 4 prefix M1s (16T) + LD IY,nn (14T, includes effective FD M1) = 30T
    // total. Trailing zeros in mem decode as NOPs whose fires we don't
    // care about — assert only on the first 4 traces.
    dbgTickN(dbg, resolve, 80);

    strictEqual(completed.length >= 4, true, `got ${completed.length} traces`);
    deepStrictEqual(completed[0], { bytes: [0xdd], tStates: 4, addr: 0 });
    deepStrictEqual(completed[1], { bytes: [0xfd], tStates: 4, addr: 1 });
    deepStrictEqual(completed[2], { bytes: [0xdd], tStates: 4, addr: 2 });
    deepStrictEqual(completed[3], {
      bytes: [0xfd, 0x21, 0x34, 0x12],
      tStates: 14,
      addr: 3,
    });
  });

  test("DD ED 57 → 2 traces (wasted DD + LD A,I)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0xdd; // wasted (ED resets the DD/FD latch)
    mem[1] = 0xed;
    mem[2] = 0x57; // LD A,I
    mem[3] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; tStates: number; addr: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({
        bytes: traceBytes(t),
        tStates: t.hc >> 1,
        addr: t.startAddr,
      });
    };

    dbgTickN(dbg, resolve, 50);

    strictEqual(completed.length >= 2, true, `got ${completed.length}`);
    deepStrictEqual(completed[0], { bytes: [0xdd], tStates: 4, addr: 0 });
    deepStrictEqual(completed[1], { bytes: [0xed, 0x57], tStates: 9, addr: 1 });
  });

  test("CB op is NOT split (single-byte prefix chain)", () => {
    // CB is fetched in its own M1, then the CB-prefixed opcode is
    // fetched in another M1 — same shape as DD/FD/ED prefixes. The
    // two bytes must surface as one trace, not two.
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0xcb; // CB prefix
    mem[1] = 0x00; // RLC B
    mem[2] = 0x00; // NOP (commit trigger)
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; addr: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({ bytes: traceBytes(t), addr: t.startAddr });
    };

    // CB(8) + opcode-M1(8) + NOP(8) = 24 HC + slack
    dbgTickN(dbg, resolve, 36);

    strictEqual(completed.length >= 1, true, `got ${completed.length}`);
    deepStrictEqual(
      completed[0],
      { bytes: [0xcb, 0x00], addr: 0 },
      "CB and its opcode byte must stay in one trace",
    );
  });

  test("DD CB d op is NOT split (compound encoding)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0xdd; // IX prefix (kept)
    mem[1] = 0xcb; // CB sub-prefix (does not cancel DD)
    mem[2] = 0x05; // displacement
    mem[3] = 0x06; // RLC (IX+5)
    mem[4] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: number[][] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push(traceBytes(t));
    };

    dbgTickN(dbg, resolve, 60);

    strictEqual(completed.length >= 1, true, `got ${completed.length}`);
    deepStrictEqual(
      completed[0],
      [0xdd, 0xcb, 0x05, 0x06],
      "DDCB stays as a single trace — CB does not split DD",
    );
  });

  // Regression: the chain-continuation and cancellation checks must look at
  // curr.length===1 + bytes[0], NOT just the last byte of curr. Otherwise an
  // operand that happens to equal a prefix byte (LD A,#$DD ⇒ trace ends in
  // 0xDD) would make the next instruction get merged into the previous
  // trace instead of starting a fresh one.
  test("LD A,#$DD ; NOP → 2 separate traces (operand-not-prefix)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x3e; // LD A,n
    mem[1] = 0xdd; //   n = 0xDD (operand, not a prefix!)
    mem[2] = 0x00; // NOP
    mem[3] = 0x00; // NOP (commit trigger)
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; tStates: number; addr: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({
        bytes: traceBytes(t),
        tStates: t.hc >> 1,
        addr: t.startAddr,
      });
    };

    // LD A,n: 7T = 14 HC. NOP: 4T = 8 HC. NOP: 4T = 8 HC.
    dbgTickN(dbg, resolve, 36);

    strictEqual(completed.length >= 2, true, `got ${completed.length} traces`);
    deepStrictEqual(
      completed[0],
      { bytes: [0x3e, 0xdd], tStates: 7, addr: 0 },
      "LD A,#$DD is its own trace; the trailing 0xDD is an operand",
    );
    deepStrictEqual(
      completed[1],
      { bytes: [0x00], tStates: 4, addr: 2 },
      "NOP at $0002 must NOT merge into the previous trace",
    );
  });

  test("totalHc advances every clockEdge regardless of enabled", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256); // all NOPs
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    strictEqual(dbg.totalHc, 0);
    dbgTickN(dbg, resolve, 10);
    strictEqual(dbg.totalHc, 10, "totalHc counts each clockEdge while enabled");

    dbg.enabled = false;
    dbgTickN(dbg, resolve, 10);
    strictEqual(dbg.totalHc, 20, "totalHc still advances while disabled");

    dbg.enabled = true;
    dbgTickN(dbg, resolve, 10);
    strictEqual(dbg.totalHc, 30, "totalHc keeps counting after re-enable");
  });

  test("disabled mode does not fire callbacks", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256); // all NOPs
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    let fires = 0;
    dbg.onInstructionComplete = () => {
      fires++;
    };

    dbg.enabled = false;
    dbgTickN(dbg, resolve, 100); // 100 HC of NOPs while disabled
    strictEqual(fires, 0, "no callbacks should fire while disabled");
  });

  test("stepHc(n, cb) fires cb after exactly n HC", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256); // all NOPs
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const startHc = dbg.totalHc;
    let fired = false;
    let firedAtHc = -1;
    dbg.stepHc(50, () => {
      fired = true;
      firedAtHc = dbg.totalHc;
    });

    // Tick until cb fires (or give up after a generous budget).
    for (let i = 0; i < 200 && !fired; i++) {
      resolve();
      dbg.clockEdge();
    }

    strictEqual(fired, true, "cb must fire");
    strictEqual(firedAtHc, startHc + 50, "cb fires exactly at startHc + n");
  });

  test("stepHc prefetch enables tracing before fire even if dbg was off", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256); // all NOPs (4T = 8 HC each)
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    dbg.enabled = false;

    const completed: number[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push(t.startAddr);
    };

    // Step 500 HC with 96 HC prefetch. After 500-96=404 HC the dbg
    // re-enables, then traces several NOPs before firing.
    let fired = false;
    dbg.stepHc(500, () => {
      fired = true;
    });

    for (let i = 0; i < 600 && !fired; i++) {
      resolve();
      dbg.clockEdge();
    }

    strictEqual(fired, true, "cb fires");
    strictEqual(dbg.enabled, true, "prefetch must have flipped enabled true");
    // 96 HC prefetch / 8 HC per NOP ≈ at least a few traces before fire.
    strictEqual(
      completed.length >= 2,
      true,
      `expected ≥2 traces in prefetch window, got ${completed.length}`,
    );
  });

  test("stepHc(1, cb) — tight step works (smaller than prefetch)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    dbg.enabled = false;

    const startHc = dbg.totalHc;
    let firedAtHc = -1;
    // n=1 with default prefetch=96: enableAt = startHc + 1 - 96 < startHc,
    // so enable must flip immediately.
    dbg.stepHc(1, () => {
      firedAtHc = dbg.totalHc;
    });

    strictEqual(dbg.enabled, true, "tight step enables immediately");

    for (let i = 0; i < 5 && firedAtHc < 0; i++) {
      resolve();
      dbg.clockEdge();
    }
    strictEqual(firedAtHc, startHc + 1);
  });

  test("stepHc called twice replaces the pending callback", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    let firstFired = 0;
    let secondFired = 0;
    dbg.stepHc(100, () => {
      firstFired++;
    });
    // Replace before the first fires.
    dbg.stepHc(50, () => {
      secondFired++;
    });

    for (let i = 0; i < 200; i++) {
      resolve();
      dbg.clockEdge();
    }

    strictEqual(firstFired, 0, "replaced cb must NOT fire");
    strictEqual(secondFired, 1, "new cb fires exactly once");
  });

  // NMI M1 asserts nRD but the fetched byte is discarded by the CPU
  // (it's a refresh-only fetch). dbg captures whatever is on the bus
  // anyway — consumers identify NMI traces by m1Type and ignore the byte.
  test("NMI trace: m1Type='nmi', tStates=11", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x00; // NOP
    mem[1] = 0x00; // NOP — NMI accepted at this NOP's T4
    mem[0x66] = 0x00; // NOP at NMI handler vector
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; m1Type: M1Type; tStates: number }[] =
      [];
    dbg.onInstructionComplete = (t) => {
      completed.push({
        bytes: traceBytes(t),
        m1Type: t.m1Type,
        tStates: t.hc >> 1,
      });
    };

    // Tick through preamble NOP, then trigger NMI before the next NOP.
    dbgTickN(dbg, resolve, 8);
    cpu.nmi();
    // Second NOP (8 HC) — NMI is acknowledged at its T4.
    // NMI response: M1(10HC) + pushH(6HC) + pushL(6HC) = 22 HC.
    // Then handler NOP at 0x66 (8 HC) + another NOP (8 HC) for commit.
    dbgTickN(dbg, resolve, 60);

    const nmiTrace = completed.find((t) => t.m1Type === "nmi");
    strictEqual(
      nmiTrace !== undefined,
      true,
      `no NMI trace among ${completed.length} fires: ${JSON.stringify(completed)}`,
    );
    strictEqual(
      nmiTrace?.tStates,
      11,
      "NMI sequence is 11T (5T M1 + 3T pushH + 3T pushL)",
    );
  });

  test("stepHc(0, ...) throws", () => {
    const cpu = new Z80Cpu();
    const dbg = new Z80DebugContext(cpu);
    let threw = false;
    try {
      dbg.stepHc(0, () => {});
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
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256); // all NOPs
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    // Arm an unfired stepHc (with default prefetch=96) that would
    // eventually force-enable dbg.
    let fired = false;
    dbg.stepHc(500, () => {
      fired = true;
    });
    // Caller exits "early" before the stepHc would fire and cleans up.
    dbg.cancelStepHc();

    // Now disable dbg and tick well past where the stepHc would have
    // force-enabled. Nothing should re-enable it.
    dbg.enabled = false;
    const completed: number[] = [];
    dbg.onInstructionComplete = () => {
      completed.push(0);
    };
    for (let i = 0; i < 1000; i++) {
      resolve();
      dbg.clockEdge();
    }

    strictEqual(fired, false, "cancelled stepHc must not fire");
    strictEqual(
      dbg.enabled,
      false,
      "cancelled stepHc must not have force-enabled dbg",
    );
    strictEqual(
      completed.length,
      0,
      "no traces should leak through disabled mode",
    );
  });

  test("state() snapshots registers, IM, IFFs, WZ", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    // LD A,42h  (7T)   →  3E 42
    // LD HL,5566h     →  21 66 55
    // LD I,A           →  ED 47    (also sets IM via separate path, but here just I=42)
    // EI               →  FB        (sets iff1=iff2=1)
    // ED 5E            →  ED 5E    (IM 2)
    // NOP              →  00       (commit trigger)
    mem[0] = 0x3e;
    mem[1] = 0x42;
    mem[2] = 0x21;
    mem[3] = 0x66;
    mem[4] = 0x55;
    mem[5] = 0xed;
    mem[6] = 0x47;
    mem[7] = 0xfb;
    mem[8] = 0xed;
    mem[9] = 0x5e;
    mem[10] = 0x00;
    mem[11] = 0x00;
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    // Tick well past the last instruction's lastOpTState + a settle window
    // for deferred writes. Total: 7+10+9+4+8 = 38T = 76 HC + NOP(8) + slack.
    dbgTickN(dbg, resolve, 110);

    const s = dbg.state();
    strictEqual(s.main.a, 0x42, "A = 42h");
    strictEqual(s.main.h, 0x55, "H = 55h");
    strictEqual(s.main.l, 0x66, "L = 66h");
    strictEqual(s.i, 0x42, "I = 42h (loaded from A)");
    strictEqual(s.im, 2, "IM 2 set by ED 5E");
    strictEqual(s.iff1, true, "EI enabled iff1");
    strictEqual(s.iff2, true, "EI enabled iff2");
    strictEqual(s.nmiPending, false);
  });

  test("decodeFlags maps every bit correctly", () => {
    // All zero
    deepStrictEqual(decodeFlags(0x00), {
      s: false,
      z: false,
      x5: false,
      h: false,
      x3: false,
      pv: false,
      n: false,
      c: false,
    });
    // All set
    deepStrictEqual(decodeFlags(0xff), {
      s: true,
      z: true,
      x5: true,
      h: true,
      x3: true,
      pv: true,
      n: true,
      c: true,
    });
    // Individual bits: walk through 0x80, 0x40, ..., 0x01
    const expectedKey: Array<keyof ReturnType<typeof decodeFlags>> = [
      "s",
      "z",
      "x5",
      "h",
      "x3",
      "pv",
      "n",
      "c",
    ];
    for (let i = 0; i < 8; i++) {
      const f = 1 << (7 - i);
      const got = decodeFlags(f);
      for (const k of expectedKey) {
        strictEqual(
          got[k],
          k === expectedKey[i],
          `bit ${7 - i} (${expectedKey[i]}) for f=${f.toString(16)}: ${k}`,
        );
      }
    }
  });

  test("state() reflects EXX bank swap", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    // LD BC,1122h ; LD DE,3344h ; LD HL,5566h ; EXX
    // LD BC,AABBh ; LD DE,CCDDh ; LD HL,EEFFh ; NOP (commit)
    mem[0] = 0x01;
    mem[1] = 0x22;
    mem[2] = 0x11;
    mem[3] = 0x11;
    mem[4] = 0x44;
    mem[5] = 0x33;
    mem[6] = 0x21;
    mem[7] = 0x66;
    mem[8] = 0x55;
    mem[9] = 0xd9;
    mem[10] = 0x01;
    mem[11] = 0xbb;
    mem[12] = 0xaa;
    mem[13] = 0x11;
    mem[14] = 0xdd;
    mem[15] = 0xcc;
    mem[16] = 0x21;
    mem[17] = 0xff;
    mem[18] = 0xee;
    mem[19] = 0x00;
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    // 3*10T LD + 4T EXX + 3*10T LD + 4T NOP = 68T = 136 HC, +slack
    dbgTickN(dbg, resolve, 170);

    const s = dbg.state();
    strictEqual(s.main.b, 0xaa, "main B is the most recent write");
    strictEqual(s.main.c, 0xbb);
    strictEqual(s.main.d, 0xcc);
    strictEqual(s.main.e, 0xdd);
    strictEqual(s.main.h, 0xee);
    strictEqual(s.main.l, 0xff);
    strictEqual(s.alt.b, 0x11, "alt B is the value swapped out by EXX");
    strictEqual(s.alt.c, 0x22);
    strictEqual(s.alt.d, 0x33);
    strictEqual(s.alt.e, 0x44);
    strictEqual(s.alt.h, 0x55);
    strictEqual(s.alt.l, 0x66);
  });

  test("state() reflects EX AF,AF' swap", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    // LD A,11h ; XOR A (sets Z flag in main F)   →  main: A=00, F=Z+...
    // EX AF,AF'
    // LD A,22h ; OR 80h (sets S flag in main F)  →  main: A=A2 (?), F=...
    //   We'll just check A swaps; F detail isn't critical for this test.
    // Restore to known values:
    // LD A,11h ; EX AF,AF' ; LD A,22h ; NOP
    mem[0] = 0x3e;
    mem[1] = 0x11; // LD A,11h
    mem[2] = 0x08; // EX AF,AF'
    mem[3] = 0x3e;
    mem[4] = 0x22; // LD A,22h
    mem[5] = 0x00; // NOP
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    dbgTickN(dbg, resolve, 60);

    const s = dbg.state();
    strictEqual(s.main.a, 0x22, "main A reflects the most recent LD");
    strictEqual(s.alt.a, 0x11, "alt A is the value swapped out by EX AF,AF'");
  });

  // Cross-bank independence of EX DE,HL: the real Z80 has TWO separate
  // exDe flip-flops (ex_dehl0 / ex_dehl1 in the netlist), multiplexed by
  // ex_bcdehl. A swap in one bank must NOT propagate to the other.
  // Sequence: swap in main, EXX into alt, write fresh DE/HL there (no
  // swap), EXX back. We expect main to still see its swap, and alt to
  // see its LDs without any swap applied.
  test("state() — EX DE,HL is per-bank (independence across EXX)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    mem[0] = 0x11;
    mem[1] = 0x22;
    mem[2] = 0x11; // LD DE,1122h  (main)
    mem[3] = 0x21;
    mem[4] = 0x44;
    mem[5] = 0x33; // LD HL,3344h  (main)
    mem[6] = 0xeb; // EX DE,HL    (main only)
    mem[7] = 0xd9; // EXX → alt
    mem[8] = 0x11;
    mem[9] = 0xbb;
    mem[10] = 0xaa; // LD DE,AABBh (alt)
    mem[11] = 0x21;
    mem[12] = 0xdd;
    mem[13] = 0xcc; // LD HL,CCDDh (alt)
    mem[14] = 0xd9; // EXX → main
    mem[15] = 0x00; // NOP (commit)
    mem[16] = 0x00;
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    // 6*10T LD + 4T EX + 2*4T EXX + 4T NOP = 80T = 160 HC, + NOP for commit.
    dbgTickN(dbg, resolve, 200);

    const s = dbg.state();
    // Main bank: EX DE,HL we did here must still be in effect after the
    // round-trip — DE and HL appear swapped.
    strictEqual(s.main.d, 0x33, "main.D after EXX round-trip = old H");
    strictEqual(s.main.e, 0x44, "main.E = old L");
    strictEqual(s.main.h, 0x11, "main.H = old D");
    strictEqual(s.main.l, 0x22, "main.L = old E");
    // Alt bank: never had EX DE,HL — the LDs we did there should appear
    // straight (DE'=AABB, HL'=CCDD), NOT swapped.
    strictEqual(s.alt.d, 0xaa, "alt.D = what LD DE wrote (no swap in alt)");
    strictEqual(s.alt.e, 0xbb);
    strictEqual(s.alt.h, 0xcc, "alt.H = what LD HL wrote (no swap in alt)");
    strictEqual(s.alt.l, 0xdd);
  });

  test("state() reflects EX DE,HL swap (in-bank swap)", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    // LD DE,1122h ; LD HL,3344h ; EX DE,HL ; NOP
    mem[0] = 0x11;
    mem[1] = 0x22;
    mem[2] = 0x11;
    mem[3] = 0x21;
    mem[4] = 0x44;
    mem[5] = 0x33;
    mem[6] = 0xeb; // EX DE,HL
    mem[7] = 0x00;
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);
    dbgTickN(dbg, resolve, 60);

    const s = dbg.state();
    strictEqual(s.main.d, 0x33, "after EX DE,HL: D = old H");
    strictEqual(s.main.e, 0x44, "after EX DE,HL: E = old L");
    strictEqual(s.main.h, 0x11, "after EX DE,HL: H = old D");
    strictEqual(s.main.l, 0x22, "after EX DE,HL: L = old E");
  });

  test("state() returns a fresh object each call", () => {
    const cpu = new Z80Cpu();
    const dbg = new Z80DebugContext(cpu);
    const a = dbg.state();
    const b = dbg.state();
    strictEqual(a === b, false, "must not share reference");
    strictEqual(a.main === b.main, false, "nested objects also fresh");
  });

  test("re-enable starts collecting from the next M1, drops in-flight", () => {
    const cpu = new Z80Cpu();
    const mem = new Uint8Array(256);
    // LD A,0x42  (7T = 14 HC), then NOP, NOP, NOP, NOP
    mem[0] = 0x3e;
    mem[1] = 0x42;
    // mem[2..] = 0x00 (NOPs)
    const resolve = makeBus(cpu, mem);
    const dbg = new Z80DebugContext(cpu);

    const completed: { bytes: number[]; addr: number }[] = [];
    dbg.onInstructionComplete = (t) => {
      completed.push({ bytes: traceBytes(t), addr: t.startAddr });
    };

    // Disable mid-LD-A-n (after 4 HC, we're partway through M1).
    dbgTickN(dbg, resolve, 4);
    dbg.enabled = false;
    // Tick through the rest of LD A,n and into the first NOP.
    // LD A,n is 14 HC, we did 4 → 10 more to finish it. Then a few into NOP.
    dbgTickN(dbg, resolve, 12);
    // Re-enable. The current NOP's M1 is already in progress (or just ended)
    // so the *next* NOP M1 should produce the first trace.
    dbg.enabled = true;
    dbgTickN(dbg, resolve, 40);

    // The LD A,0x42 must NOT appear — it was in flight when we disabled.
    for (const t of completed) {
      if (t.bytes[0] === 0x3e) {
        throw new Error(`LD A,n leaked into trace: ${JSON.stringify(t)}`);
      }
    }
    // We should see *some* NOPs from after re-enable.
    strictEqual(
      completed.length >= 1,
      true,
      `expected at least one trace after re-enable, got ${completed.length}`,
    );
    // Every trace we did see should be a clean NOP starting at addr >= 2.
    for (const t of completed) {
      deepStrictEqual(t.bytes, [0x00], `unexpected bytes ${JSON.stringify(t)}`);
    }
  });
});
