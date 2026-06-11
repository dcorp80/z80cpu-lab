// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// z80cpu-cli/src/repl.ts — minimal interactive REPL around Z80Cpu + Z80DebugContext + disasm.
//
// Usage:
//   z80cpu-repl <path>          (when installed)
//   node dist/repl.js <path>    (from this package)
//
// <path> can be a raw binary or an ASCII CSV of decimal bytes (the same
// format the mixer benchmark uses). The program is loaded at $0000.
//
// Commands:
//   <empty line>   step until the next trace fires (one instruction or one
//                  wasted prefix M1 — each surfaces as its own trace per dbg)
//   <integer N>    fast-forward N half-cycles with tracing OFF (no output)
//   b <addr>       set a PC breakpoint at <addr> (hex)
//   b <lo> <hi>    set a PC breakpoint covering <lo>..<hi> inclusive (hex)
//   b              show the current breakpoint
//   b -            clear the breakpoint
//   c              continue: free-run (no tracing) until the breakpoint hits
//   exit           quit  (Ctrl-D also works)
//
// Hex inputs accept bare, `0x…`, or `$…`. See README.md.

import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Z80Cpu } from "@dcorp80/z80cpu";
import {
  type BreakHandle,
  type CpuState,
  decodeFlags,
  type HcCounter,
  type InstructionTrace,
  Z80Breakpoints,
  Z80DebugContext,
} from "@dcorp80/z80cpu-debug";
import { disasm } from "@dcorp80/z80cpu-disasm";

// ─── Program loader ────────────────────────────────────────────────────────

function loadProgram(path: string): number[] {
  const buf = readFileSync(path);
  if (buf.length === 0) return [];
  const first = buf[0];
  const isAsciiDigit = first >= 0x30 && first <= 0x39;
  if (!isAsciiDigit) return Array.from(buf);
  const text = buf.toString("ascii");
  const parts = text.split(/[,\s]+/).filter((s) => s.length > 0);
  const out = new Array<number>(parts.length);
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

// ─── 64K memory + IO bus resolver ──────────────────────────────────────────

function makeBus64k(cpu: Z80Cpu) {
  const mem = new Array<number>(0x10000).fill(0);
  const io = new Array<number>(0x10000).fill(0);
  const resolve = () => {
    const { nMREQ, nIORQ, nRD, nWR, addr, data } = cpu.bus;
    if (!nMREQ) {
      const a = (addr ?? 0) & 0xffff;
      if (!nRD) cpu.bus.data = mem[a];
      if (!nWR && data !== undefined) mem[a] = data;
    }
    if (!nIORQ) {
      const a = (addr ?? 0) & 0xffff;
      if (!nRD) cpu.bus.data = io[a];
      if (!nWR && data !== undefined) io[a] = data;
    }
  };
  return { mem, io, resolve };
}

// ─── Trace formatting ──────────────────────────────────────────────────────

const hex16 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

// Parse a hex address from "1234" / "0x1234" / "$1234". Returns null if the
// input isn't a valid 16-bit hex number.
function parseHexAddr(s: string): number | null {
  const cleaned = s.replace(/^(0x|\$)/i, "");
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  const n = parseInt(cleaned, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n;
}

function fmtState(s: CpuState): string {
  const m = s.main,
    a = s.alt;
  const pair = (hi: number, lo: number) => hex16((hi << 8) | lo);
  // Order: S Z 5 H 3 P/V N C (bits 7..0). Lowercase letter = set, '.' = clear.
  const flagStr = (f: number) => {
    const fl = decodeFlags(f);
    return (
      (fl.s ? "S" : ".") +
      (fl.z ? "Z" : ".") +
      (fl.x5 ? "5" : ".") +
      (fl.h ? "H" : ".") +
      (fl.x3 ? "3" : ".") +
      (fl.pv ? "P" : ".") +
      (fl.n ? "N" : ".") +
      (fl.c ? "C" : ".")
    );
  };
  return [
    `  PC=${hex16(s.pc)}  SP=${hex16(s.sp)}  IX=${hex16(s.ix)}  IY=${hex16(s.iy)}  WZ=${hex16(s.wz)}`,
    `  AF=${pair(m.a, m.f)} BC=${pair(m.b, m.c)} DE=${pair(m.d, m.e)} HL=${pair(m.h, m.l)}  F=${flagStr(m.f)}`,
    `  AF'=${pair(a.a, a.f)} BC'=${pair(a.b, a.c)} DE'=${pair(a.d, a.e)} HL'=${pair(a.h, a.l)}  F'=${flagStr(a.f)}`,
    `  I=${hex8(s.i)}  R=${hex8(s.r)}  IM ${s.im}${s.imUndocumented ? "*" : ""}  IFF1=${s.iff1 ? 1 : 0}  IFF2=${s.iff2 ? 1 : 0}` +
      (s.nmiPending ? "  NMI-pending" : ""),
  ].join("\n");
}

function fmtTrace(t: InstructionTrace): string {
  const addr = hex16(t.startAddr);

  // Raw bytes column (up to 4 bytes shown, pad to fixed width)
  const bytesArr = Array.from({ length: t.length }, (_, i) => t.bytes[i]);
  const bytesStr = bytesArr.map(hex8).join(" ");

  // Disassembly + undocumented marker
  const d = disasm(bytesArr);
  const mnemonic = d.text + (d.undocumented ? " *" : "");

  // Jump / target annotation
  let target = "";
  if (d.abs !== undefined) target = `→ ${hex16(d.abs)}h`;
  else if (d.rel !== undefined) {
    const dest = (t.startAddr + t.length + d.rel) & 0xffff;
    const sign = d.rel >= 0 ? "+" : "";
    target = `→ ${hex16(dest)}h  (${sign}${d.rel})`;
  }

  // Special M1 tag (NMI/INT/HALT/special_reset)
  const tag = t.m1Type === "normal" ? "" : `[${t.m1Type.toUpperCase()}] `;

  return [
    addr.padEnd(4),
    bytesStr.padEnd(14),
    (tag + mnemonic).padEnd(24),
    `${t.hc >> 1}T`.padStart(4),
    `next=${hex16(t.nextPc)}`.padEnd(11),
    target,
  ]
    .join("  ")
    .trimEnd();
}

// ─── REPL ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node z80-core/cli/repl.ts <binary-or-csv-path>");
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`not found: ${path}`);
    process.exit(1);
  }

  const program = loadProgram(path);
  const cpu = new Z80Cpu();
  const { mem, resolve } = makeBus64k(cpu);
  for (let i = 0; i < program.length; i++) mem[i] = program[i];

  const dbg = new Z80DebugContext(cpu);
  dbg.onInstructionComplete = (t) => {
    console.log(fmtTrace(t));
  };

  // Half-cycle counter owned by the REPL (the dbg no longer tracks HC;
  // see z80cpu-debug:HcCounter). Single Float64Array slot ticked by the
  // tick helper below. Passed to Z80Breakpoints by reference so its
  // stepHc check stays an unboxed-double indexed load.
  const hcBox = new Float64Array(1);
  const hc: HcCounter = { box: hcBox, index: 0 };
  const bp = new Z80Breakpoints(dbg, hc);

  // Run one full edge: bus resolve → dbg.clockEdge → tick HC → bp scan.
  // Every tick site in the REPL goes through this helper so the four
  // steps stay in lockstep.
  const tickEdge = (): void => {
    resolve();
    dbg.clockEdge();
    hcBox[0]++;
    bp.tickAfterEdge();
  };

  // REPL holds a single breakpoint slot. `b <addr>` replaces it; `b -` clears.
  // The cb only sets a local flag — the `c` command's tick loop watches it.
  let bpHandle: BreakHandle | null = null;
  let bpRange: { lo: number; hi: number } | null = null;
  let bpHit = false;

  console.log(`loaded ${program.length} bytes from ${path}`);
  console.log(
    "commands: <enter>=step one trace, <N>=skip N HC (tracing off), exit=quit",
  );

  // Single readline kept alive for the whole session. We can't use
  // rl.question() because piped stdin emits 'line' events faster than the
  // REPL consumes them — lines after the first would be dropped. Instead
  // we queue line events and dispatch them to ask() callers.
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  let pending: ((s: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (pending) {
      const p = pending;
      pending = null;
      p(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    if (pending) {
      const p = pending;
      pending = null;
      p(null);
    }
  });
  const ask = (): Promise<string | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    process.stdout.write("z80> ");
    return new Promise((res) => {
      pending = res;
    });
  };

  while (true) {
    const raw = await ask();
    if (raw === null) {
      console.log("bye");
      return;
    }
    const input = raw.trim();

    if (input === "exit") {
      console.log("bye");
      rl.close();
      return;
    }

    if (input === "") {
      // Step until one trace fires. Use bp.stepHc with a huge n + early
      // break in the onInstructionComplete: when the user's printer
      // fires, set `fired = true` and exit the tick loop. stepHc here
      // is just a safety net to avoid runaway if no instruction ever
      // completes (broken program / infinite halt loop with disabled
      // interrupts).
      let fired = false;
      const userPrint = dbg.onInstructionComplete;
      dbg.onInstructionComplete = (t) => {
        userPrint(t);
        fired = true;
      };
      let timedOut = false;
      bp.stepHc(
        1024,
        () => {
          timedOut = true;
        },
        0,
      );
      while (!fired && !timedOut) tickEdge();
      dbg.onInstructionComplete = userPrint;
      // If we exited via `fired`, the stepHc safety timeout is still
      // armed — and its hidden prefetch logic would force-enable dbg
      // mid-way through a later `c` loop. Always cancel after exit.
      bp.cancelStepHc();
      if (timedOut)
        console.log("(no trace fired in 1024 HC — program may be stuck)");
      else console.log(fmtState(dbg.state()));
      continue;
    }

    if (input === "c") {
      if (bpHandle === null) {
        console.log("no breakpoint set; use `b <addr>` first");
        continue;
      }
      bpHit = false;
      // Free-run: bp.tickAfterEdge auto-enables dbg when the breakpoint
      // fires (the force-enable hook on PC-bp hit).
      dbg.enabled = false;
      while (!bpHit) tickEdge();
      console.log(`(break at ${hex16(dbg.state().pc)})`);
      console.log(fmtState(dbg.state()));
      continue;
    }

    const bMatch = input.match(/^b(?:\s+(.+))?$/);
    if (bMatch) {
      const args = bMatch[1]?.trim();
      if (!args) {
        if (bpRange === null) console.log("no breakpoint set");
        else if (bpRange.lo === bpRange.hi)
          console.log(`breakpoint: ${hex16(bpRange.lo)}h`);
        else
          console.log(
            `breakpoint: ${hex16(bpRange.lo)}h..${hex16(bpRange.hi)}h`,
          );
        continue;
      }
      if (args === "-" || args === "clear" || args === "off") {
        if (bpHandle) bpHandle.remove();
        bpHandle = null;
        bpRange = null;
        bpHit = false;
        console.log("breakpoint cleared");
        continue;
      }
      const parts = args.split(/\s+/);
      const lo = parseHexAddr(parts[0]);
      const hi = parts.length >= 2 ? parseHexAddr(parts[1]) : lo;
      if (lo === null || hi === null || parts.length > 2) {
        console.log(
          "usage: b [<addr> | <lo> <hi> | -]   (hex; bare/$…/0x… accepted)",
        );
        continue;
      }
      if (lo > hi) {
        console.log(`bad range: ${hex16(lo)}h > ${hex16(hi)}h`);
        continue;
      }
      if (bpHandle) bpHandle.remove();
      bpRange = { lo, hi };
      bpHit = false;
      bpHandle = bp.addPcBreak(lo, hi, () => {
        bpHit = true;
      });
      if (lo === hi) console.log(`breakpoint set at ${hex16(lo)}h`);
      else console.log(`breakpoint set ${hex16(lo)}h..${hex16(hi)}h`);
      continue;
    }

    if (/^\d+$/.test(input)) {
      const n = parseInt(input, 10);
      if (n <= 0) {
        console.log("N must be > 0");
        continue;
      }
      const startHc = hcBox[0];
      // Disable tracing for the bulk of the skip; stepHc's default
      // prefetch (96 HC) auto-flips `enabled` back on shortly before
      // the target, so the final few instructions print as context
      // for where we stopped.
      dbg.enabled = false;
      let done = false;
      bp.stepHc(n, () => {
        done = true;
      }); // default prefetchHc = 96
      while (!done) tickEdge();
      console.log(`(skipped ${n} HC; totalHc ${startHc} → ${hcBox[0]})`);
      continue;
    }

    console.log(`unknown command: ${JSON.stringify(input)}`);
  }
}

await main();
