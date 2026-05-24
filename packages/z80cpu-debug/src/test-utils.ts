// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// z80-test-utils.ts — Unified test utility orchestrator.
//
// Usage in tests:
//   import { Z80Cpu, A, B, ... } from "./z80-test-utils.ts";
//
//   node --test *.test.ts

import { strictEqual } from "node:assert/strict";
import {
  A,
  A_,
  B,
  B_,
  C,
  C_,
  D,
  D_,
  E,
  E_,
  H,
  H_,
  IXH,
  IXL,
  IYH,
  IYL,
  L,
  L_,
  Z80Cpu,
} from "@dcorp80/z80cpu";
import type { RegSetup } from "./preamble.ts";
import { preamble } from "./preamble.ts";

export type { PreambleResult, RegSetup } from "./preamble.ts";
export {
  A,
  A_,
  B,
  B_,
  C,
  C_,
  D,
  D_,
  E,
  E_,
  H,
  H_,
  IXH,
  IXL,
  IYH,
  IYL,
  L,
  L_,
  preamble,
  Z80Cpu,
};

export function hex8(v: number): string {
  return v != null && !Number.isNaN(v) ? v.toString(16).padStart(2, "0") : "??";
}

export function hex16(v: number): string {
  return v.toString(16).padStart(4, "0");
}

// Memory + port bus resolver
export function makeBus(
  cpu: Z80Cpu,
  mem: Uint8Array,
  ports?: Record<number, number>,
) {
  return () => {
    const { nMREQ, nIORQ, nRD, nWR, addr, data } = cpu.bus;
    if (nMREQ === 0) {
      if (nRD === 0) cpu.bus.data = mem[addr & 0xff];
      if (nWR === 0 && data !== undefined) mem[addr & 0xff] = data;
    }
    if (ports && nIORQ === 0) {
      const port = addr & 0xff;
      if (nWR === 0 && data !== undefined) ports[port] = data;
      if (nRD === 0) cpu.bus.data = ports[port] ?? 0xff;
    }
  };
}

// 64KB memory + port bus resolver — no address masking
export function makeBus16(
  cpu: Z80Cpu,
  mem: Uint8Array,
  ports?: Record<number, number>,
) {
  return () => {
    const { nMREQ, nIORQ, nRD, nWR, addr, data } = cpu.bus;
    if (nMREQ === 0) {
      if (nRD === 0) cpu.bus.data = mem[addr];
      if (nWR === 0 && data !== undefined) mem[addr] = data;
    }
    if (ports && nIORQ === 0) {
      const port = addr & 0xff;
      if (nWR === 0 && data !== undefined) ports[port] = data;
      if (nRD === 0) cpu.bus.data = ports[port] ?? 0xff;
    }
  };
}

// Tick helper: resolve bus then clock
export function tick(cpu: Z80Cpu, resolve: () => void) {
  resolve();
  cpu.clockEdge();
}

// Run N half-cycles
export function tickN(cpu: Z80Cpu, resolve: () => void, n: number = 1) {
  for (let i = 0; i < n; i++) tick(cpu, resolve);
}

// ── Shared test helpers (backend-agnostic via preamble) ──────────

// General helpers
export const conditionMathchWithin = (
  cpu: Z80Cpu,
  resolve: () => void,
  condition: (cpu: Z80Cpu) => boolean,
  within: number,
) => {
  for (let i = 0; i < within; i++) {
    tick(cpu, resolve);
    if (condition(cpu)) return i + 1;
  }
  return -1;
};

// Test ALU reg-op (opcode with z=0..5 → B..L operand), assert A and F
export function testAluOp(
  label: string,
  opcode: number,
  a: number,
  b: number,
  f: number,
  expectA: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const { p, hc } = preamble(mem, { a, b, f });
  mem[p] = opcode;
  mem[p + 1] = 0x00; // NOP — applies deferred A and F writes
  const resolve = makeBus(cpu, mem);
  // ALU op M1 = 8 half-cycles, NOP M1 = 8 half-cycles
  tickN(cpu, resolve, hc + 16);
  strictEqual(
    cpu.regs.file[A],
    expectA,
    `${label}: A=${hex8(cpu.regs.file[A])} expected ${hex8(expectA)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Test ALU op with immediate operand (ADD/ADC/SUB/SBC/AND/XOR/OR/CP A,n)
export function testAluN(
  label: string,
  opcode: number,
  a: number,
  n: number,
  f: number,
  expectA: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const { p, hc } = preamble(mem, { a, f });
  mem[p] = opcode;
  mem[p + 1] = n; // immediate operand
  mem[p + 2] = 0x00; // NOP — applies deferred A and F writes
  const resolve = makeBus(cpu, mem);
  // ALU,n: M1(8) + opRd(6) = 14, NOP: M1(8) = 8, total = 22
  tickN(cpu, resolve, hc + 22);
  strictEqual(
    cpu.regs.file[A],
    expectA,
    `${label}: A=${hex8(cpu.regs.file[A])} expected ${hex8(expectA)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Test ALU op with (HL) operand
export function testAluHL(
  label: string,
  opcode: number,
  a: number,
  hlVal: number,
  f: number,
  expectA: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const { p, hc } = preamble(mem, { a, h: 0x00, l: 0x50, f });
  mem[p] = opcode; // ADD/ADC A,(HL)
  mem[p + 1] = 0x00; // NOP
  mem[0x50] = hlVal; // data at (HL)
  const resolve = makeBus(cpu, mem);
  // ADD/ADC A,(HL): M1(8) + mRd(6) = 14, NOP: M1(8) = 8, total = 22
  tickN(cpu, resolve, hc + 22);
  strictEqual(
    cpu.regs.file[A],
    expectA,
    `${label}: A=${hex8(cpu.regs.file[A])} expected ${hex8(expectA)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Test ALU self-op (z=7, operand is A)
export function testAluAA(
  label: string,
  opcode: number,
  a: number,
  f: number,
  expectA: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const { p, hc } = preamble(mem, { a, f });
  mem[p] = opcode;
  mem[p + 1] = 0x00; // NOP
  const resolve = makeBus(cpu, mem);
  tickN(cpu, resolve, hc + 16);
  strictEqual(
    cpu.regs.file[A],
    expectA,
    `${label}: A=${hex8(cpu.regs.file[A])} expected ${hex8(expectA)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Test INC/DEC (HL) — sets memory value, runs opcode + NOP, checks memory and F
export function testIncDecHL(
  label: string,
  opcode: number,
  val: number,
  initF: number,
  expectVal: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const { p, hc } = preamble(mem, { h: 0x00, l: 0x50, f: initF });
  mem[p] = opcode;
  mem[p + 1] = 0x00; // NOP
  mem[0x50] = val; // data at (HL)
  const resolve = makeBus(cpu, mem);
  // INC/DEC (HL): M1(8) + mRd(6) + internal(2) + mWr(6) = 22, NOP: M1(8) = 8, total = 30
  tickN(cpu, resolve, hc + 30);
  strictEqual(
    mem[0x50],
    expectVal,
    `${label}: mem=${hex8(mem[0x50])} expected ${hex8(expectVal)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Test INC/DEC rr (16-bit register pair) — no flag changes
export function testIncDecRR(
  label: string,
  opcode: number,
  pairIdx: number, // 0=BC, 1=DE, 2=HL, 3=SP
  initVal: number,
  initF: number,
  expectVal: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const setup: RegSetup = { f: initF };
  if (pairIdx === 3) setup.sp = initVal;
  else {
    const hi = initVal >>> 8,
      lo = initVal & 0xff;
    if (pairIdx === 0) {
      setup.b = hi;
      setup.c = lo;
    } else if (pairIdx === 1) {
      setup.d = hi;
      setup.e = lo;
    } else {
      setup.h = hi;
      setup.l = lo;
    }
  }
  const { p, hc } = preamble(mem, setup);
  mem[p] = opcode;
  mem[p + 1] = 0x00; // NOP
  const resolve = makeBus(cpu, mem);
  // INC/DEC rr: M1(8HC) + internal(2HC) + internal(2HC) = 12HC, NOP: 8HC, total: 20HC
  tickN(cpu, resolve, hc + 20);

  let actual: number;
  if (pairIdx === 3) actual = cpu.regs.sp;
  else
    actual = (cpu.regs.file[pairIdx * 2] << 8) | cpu.regs.file[pairIdx * 2 + 1];

  strictEqual(
    actual,
    expectVal,
    `${label}: val=${hex16(actual)} expected ${hex16(expectVal)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Test INC/DEC register — sets target register, runs opcode + NOP, checks register and F
export function testIncDec(
  label: string,
  opcode: number,
  regIdx: number, // 0=B..5=L, 7=A
  val: number,
  initF: number,
  expectVal: number,
  expectF: number,
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const setup: RegSetup = { f: initF };
  switch (regIdx) {
    case 0:
      setup.b = val;
      break;
    case 1:
      setup.c = val;
      break;
    case 2:
      setup.d = val;
      break;
    case 3:
      setup.e = val;
      break;
    case 4:
      setup.h = val;
      break;
    case 5:
      setup.l = val;
      break;
    case 7:
      setup.a = val;
      break;
  }
  const { p, hc } = preamble(mem, setup);
  mem[p] = opcode;
  mem[p + 1] = 0x00; // NOP
  const resolve = makeBus(cpu, mem);
  tickN(cpu, resolve, hc + 16);

  const actual = cpu.regs.file[regIdx];
  strictEqual(
    actual,
    expectVal,
    `${label}: reg=${hex8(actual)} expected ${hex8(expectVal)}`,
  );
  strictEqual(
    cpu.regs.f[0],
    expectF,
    `${label}: F=${hex8(cpu.regs.f[0])} expected ${hex8(expectF)}`,
  );
}

// Run a multi-instruction program and return the cpu after all M1 cycles
export function runProg(
  program: number[],
  a: number,
  f: number,
  mainRegs?: number[],
) {
  const cpu = new Z80Cpu();
  const mem = new Uint8Array(256);
  const setup: RegSetup = { a, f };
  if (mainRegs) {
    if (mainRegs.length > 0) setup.b = mainRegs[0];
    if (mainRegs.length > 1) setup.c = mainRegs[1];
    if (mainRegs.length > 2) setup.d = mainRegs[2];
    if (mainRegs.length > 3) setup.e = mainRegs[3];
    if (mainRegs.length > 4) setup.h = mainRegs[4];
    if (mainRegs.length > 5) setup.l = mainRegs[5];
  }
  const { p, hc } = preamble(mem, setup);
  for (let i = 0; i < program.length; i++) mem[p + i] = program[i];
  const resolve = makeBus(cpu, mem);
  // Run until after the last NOP (approximate: count bytes × 8 HC each)
  tickN(cpu, resolve, hc + program.length * 8);
  return cpu;
}
