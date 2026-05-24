// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// Z80DebugContext overhead benchmark.
//
// Runs the mixer program twice on the TS emulator:
//   1. Plain  cpu.clockEdge()      — baseline
//   2. Wrapped dbg.clockEdge()     — observes bus signals, builds InstructionTrace
//
// Both runs use the same program, counter, settle window, and sentinel. We
// assert the final CPU state (registers + memory SHA + IO SHA) matches between
// the two — Z80DebugContext is a pure observer, so any divergence is a bug.
// The reported numbers quantify the slowdown the dbg wrapper adds.
//
// Run:
//   node --test z80-core/benchmark/dbg-overhead.bench.test.ts
//
// Override defaults via env:
//   MIXER_ITER_COUNT=10     → fewer outer-loop iterations (1..255)
//   MIXER_MAX_HC=200000000  → safety budget (default 10 M HC)

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Z80Cpu } from "@dcorp80/z80cpu";
import { Z80DebugContext } from "@dcorp80/z80cpu-debug";
import { makeBus64k } from "./bus.ts";
import { snapshot } from "./snapshot.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, "mixer.bin");

const COUNTER_ADDR = 0xc000;
const SENTINEL_ADDR = 0xcffe;
const SENTINEL_VAL = 0xde;
const SETTLE_HC = 32;

function loadProgram(path: string): Array<number> {
  const buf = readFileSync(path);
  if (buf.length === 0) return [];
  const first = buf[0];
  const isAsciiDigit = first >= 0x30 && first <= 0x39;
  if (!isAsciiDigit) return [...buf];
  const text = buf.toString("ascii");
  const parts = text.split(/[,\s]+/).filter((s) => s.length > 0);
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) {
      throw new Error(
        `bad byte at index ${i} in ${path}: ${JSON.stringify(parts[i])}`,
      );
    }
    out[i] = n;
  }
  return out;
}

function getEnvInt(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

interface RunResult {
  ms: number;
  hc: number;
  instructions: number;
  cpu: Z80Cpu;
  mem: Array<number>;
  io: Array<number>;
}

function runPlain(
  bin: Array<number>,
  iterCount: number,
  maxHc: number,
): RunResult {
  const cpu = new Z80Cpu();
  const { mem, io, resolve } = makeBus64k(cpu);
  for (let i = 0; i < bin.length; i++) mem[i] = bin[i];
  mem[COUNTER_ADDR] = iterCount;

  let hc = 0;
  let instructions = 0;
  let prevNm1: number | undefined = 1;

  const t0 = performance.now();
  while (mem[SENTINEL_ADDR] !== SENTINEL_VAL && hc < maxHc) {
    resolve();
    cpu.clockEdge();
    hc++;
    if (prevNm1 === 1 && cpu.bus.nM1 === 0) instructions++;
    prevNm1 = cpu.bus.nM1;
  }
  for (let i = 0; i < SETTLE_HC; i++) {
    resolve();
    cpu.clockEdge();
    hc++;
  }
  const t1 = performance.now();

  if (mem[SENTINEL_ADDR] !== SENTINEL_VAL) {
    throw new Error(
      `plain run hit MIXER_MAX_HC=${maxHc} before reaching sentinel`,
    );
  }
  return { ms: t1 - t0, hc, instructions, cpu, mem, io };
}

function runDbg(
  bin: Array<number>,
  iterCount: number,
  maxHc: number,
  enabled = true,
): RunResult & { dbgCompleted: number } {
  const cpu = new Z80Cpu();
  const { mem, io, resolve } = makeBus64k(cpu);
  const dbg = new Z80DebugContext(cpu);
  dbg.enabled = enabled;
  let dbgCompleted = 0;
  dbg.onInstructionComplete = () => {
    dbgCompleted++;
  };

  for (let i = 0; i < bin.length; i++) mem[i] = bin[i];
  mem[COUNTER_ADDR] = iterCount;

  let hc = 0;
  let instructions = 0;
  let prevNm1: number | undefined = 1;

  const t0 = performance.now();
  while (mem[SENTINEL_ADDR] !== SENTINEL_VAL && hc < maxHc) {
    resolve();
    dbg.clockEdge();
    hc++;
    if (prevNm1 === 1 && cpu.bus.nM1 === 0) instructions++;
    prevNm1 = cpu.bus.nM1;
  }
  for (let i = 0; i < SETTLE_HC; i++) {
    resolve();
    dbg.clockEdge();
    hc++;
  }
  const t1 = performance.now();

  if (mem[SENTINEL_ADDR] !== SENTINEL_VAL) {
    throw new Error(
      `dbg run hit MIXER_MAX_HC=${maxHc} before reaching sentinel`,
    );
  }
  return { ms: t1 - t0, hc, instructions, cpu, mem, io, dbgCompleted };
}

const skipReason = !existsSync(BIN_PATH)
  ? `output.bin not found at ${BIN_PATH} — compile mixer.asm first ` +
    `(sjasmplus mixer.asm --raw=output.bin)`
  : false;

test("z80dbg overhead vs plain cpu", { skip: skipReason }, () => {
  const iterCount = getEnvInt("MIXER_ITER_COUNT", 100, 1, 255);
  const maxHc = getEnvInt("MIXER_MAX_HC", 10_000_000, 1);
  const bin = loadProgram(BIN_PATH);

  // Warmup pass with a tiny iter count — lets V8 JIT the hot paths of all
  // three variants before we time them.
  runPlain(bin, 1, maxHc);
  runDbg(bin, 1, maxHc, true);
  runDbg(bin, 1, maxHc, false);

  // Measured passes.
  const plain = runPlain(bin, iterCount, maxHc);
  const dbgOn = runDbg(bin, iterCount, maxHc, true);
  const dbgOff = runDbg(bin, iterCount, maxHc, false);

  const fmt = (ms: number, hc: number) => {
    const hcPerSec = hc / (ms / 1000);
    return {
      ms,
      mhcs: hcPerSec / 1e6,
      mhz: hcPerSec / 2e6,
    };
  };
  const p = fmt(plain.ms, plain.hc);
  const dn = fmt(dbgOn.ms, dbgOn.hc);
  const df = fmt(dbgOff.ms, dbgOff.hc);

  console.log(
    `dbg-overhead: iter=${iterCount}  hc=${plain.hc.toLocaleString()}  ` +
      `instr=${plain.instructions.toLocaleString()}`,
  );
  console.log(
    `  plain     : ${p.ms.toFixed(2).padStart(8)} ms  ` +
      `${p.mhcs.toFixed(2).padStart(6)} M HC/s  => ${p.mhz.toFixed(2)} MHz`,
  );
  const pct = (n: number) => `${(n >= 0 ? "+" : "") + n.toFixed(1)}%`;
  console.log(
    `  dbg off   : ${df.ms.toFixed(2).padStart(8)} ms  ` +
      `${df.mhcs.toFixed(2).padStart(6)} M HC/s  => ${df.mhz.toFixed(2)} MHz  ` +
      `(${pct((df.ms / p.ms - 1) * 100)} vs plain)`,
  );
  console.log(
    `  dbg on    : ${dn.ms.toFixed(2).padStart(8)} ms  ` +
      `${dn.mhcs.toFixed(2).padStart(6)} M HC/s  => ${dn.mhz.toFixed(2)} MHz  ` +
      `(${pct((dn.ms / p.ms - 1) * 100)} vs plain, ` +
      `${dbgOn.dbgCompleted.toLocaleString()} traces fired)`,
  );

  // Z80DebugContext is observation-only; both dbg runs must end in identical
  // state as plain (enable flag must not affect the CPU).
  strictEqual(dbgOn.hc, plain.hc, "dbg-on hc must match plain");
  strictEqual(
    dbgOn.instructions,
    plain.instructions,
    "dbg-on instr count must match",
  );
  strictEqual(dbgOff.hc, plain.hc, "dbg-off hc must match plain");
  strictEqual(
    dbgOff.instructions,
    plain.instructions,
    "dbg-off instr count must match",
  );

  const snapPlain = snapshot(
    plain.cpu,
    plain.mem,
    plain.io,
    plain.hc,
    plain.instructions,
  );
  const snapDbgOn = snapshot(
    dbgOn.cpu,
    dbgOn.mem,
    dbgOn.io,
    dbgOn.hc,
    dbgOn.instructions,
  );
  const snapDbgOff = snapshot(
    dbgOff.cpu,
    dbgOff.mem,
    dbgOff.io,
    dbgOff.hc,
    dbgOff.instructions,
  );
  deepStrictEqual(snapDbgOn, snapPlain, "dbg-on final state must match plain");
  deepStrictEqual(
    snapDbgOff,
    snapPlain,
    "dbg-off final state must match plain",
  );
});
