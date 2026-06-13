# z80cpu-lab

Companion toolkit for [`@dcorp80/z80cpu`](https://www.npmjs.com/package/@dcorp80/z80cpu)
— the half-cycle-accurate Z80 emulator. The CPU core ships from a separate
repo as a clean, dependency-free library; everything here is downstream.

## 🔬 z80cpu-explorer — visual debugger in the browser

**▶ Try it live: [dcorp80.github.io/z80cpu-lab](https://dcorp80.github.io/z80cpu-lab/)**

Load a Z80 program and watch it run half-cycle by half-cycle. Disassembled
instruction trace, live register file, 64K memory and IO grids, a
hardware-pin oscilloscope showing every bus transition, click-to-assert
input pins (nINT, nNMI, nRESET), PC and HC breakpoints — all side by side,
all live. Foldable, reorderable, persists across reloads.

→ Source and details: [`apps/z80cpu-explorer/`](apps/z80cpu-explorer/).
→ Guided tour: [Mandelbrot example](apps/z80cpu-explorer/examples/mandelbrot/README.md) — load a binary, single-step, set HC and PC breakpoints, watch the picture fill in, and service an NMI against the halted CPU.
→ Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Packages

| Package | What it does |
|---|---|
| [`@dcorp80/z80cpu-debug`](packages/z80cpu-debug) | Wraps `Z80Cpu` as a pure observer. Surfaces each completed instruction as an `InstructionTrace` (bytes, M1 type, half-cycles, next-PC), plus PC-range breakpoints and half-cycle stepping. The core of the lab. |
| [`@dcorp80/z80cpu-disasm`](packages/z80cpu-disasm) | Stateless, dependency-free Z80 disassembler. Consumes byte windows (e.g. from a debug trace) and returns mnemonic + operand metadata. All output styling lives in one `STYLE` object. |
| [`@dcorp80/z80cpu-cli`](packages/z80cpu-cli) | `z80cpu-repl` — interactive shell that loads a program at `$0000` and lets you step, fast-forward, and break by PC range, with disassembled trace output and a full register snapshot. |
| [`@dcorp80/z80cpu-bench`](packages/z80cpu-bench) | Overhead benchmark: runs the same Z80 program three ways (plain CPU, dbg-on, dbg-off) and asserts identical final state across all three. Reports the slowdown the debug wrapper adds. |

## Requirements

- **Node.js 24+** (current LTS). The test suite runs TypeScript directly via
  Node's native type-stripping; libraries are consumed from source within
  the monorepo without a build step.

## Quick start

```bash
git clone https://github.com/dcorp80/z80cpu-lab.git
cd z80cpu-lab
npm install
npm test
```

Run the REPL on a Z80 program (raw binary or ASCII CSV of decimal bytes,
loaded at `$0000`):

```bash
npm run build -w @dcorp80/z80cpu-cli
node packages/z80cpu-cli/dist/repl.js path/to/program.bin
```

Example session:

```text
z80> b 0010                    # set a PC breakpoint at $0010
breakpoint set at 0010h
z80> c                         # free-run until it fires
(break at 0010)
  PC=0010  SP=FFFE  IX=0000  IY=0000  WZ=000F
  AF=4200 BC=0000 DE=0000 HL=0000  F=........
z80>                           # <enter> steps one instruction
0010  3A 34 12       LD A,(1234h)              13T  next=0013
  PC=0013  ...
```

Full command reference in [`packages/z80cpu-cli/README.md`](packages/z80cpu-cli/README.md).

## Using the debug package in your own code

### Tracing

```ts
import { Z80Cpu } from "@dcorp80/z80cpu";
import { Z80DebugContext } from "@dcorp80/z80cpu-debug";

const cpu = new Z80Cpu();
const dbg = new Z80DebugContext(cpu);

dbg.onInstructionComplete = (t) => {
  const bytes = t.bytes.slice(0, t.length)
    .map(b => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`${t.startAddr.toString(16)}: ${bytes}  ${t.hc >> 1}T`);
};

// Drive dbg.clockEdge() in place of cpu.clockEdge().
for (;;) dbg.clockEdge();
```

There is one footgun worth knowing about: the callback fires at `m1_t3_1`
of the **next** instruction's M1, not at the end of the instruction being
reported (the Z80 commits deferred A/F writes one M1 later, so earlier
reporting would show stale flags). Use `trace.nextPc` for "PC after this
instruction"; `dbg.state().pc` reads live and is off by one mid-fetch.
The full timing model is in [`packages/z80cpu-debug/README.md`](packages/z80cpu-debug/README.md#timing--when-does-the-callback-fire).

### Breakpoints and the HC counter

As of [v0.2.0](CHANGELOG.md), PC-range
breakpoints and the half-cycle counter live outside `Z80DebugContext`:
`Z80Breakpoints` is a separate observer, and the consumer owns the HC
slot. The split keeps the tracer pure and lets multi-CPU systems share
one `Float64Array` buffer across counters.

```ts
import { Z80Breakpoints, type HcCounter } from "@dcorp80/z80cpu-debug";

// Float64Array slot avoids HeapNumber sawtooth past V8's SMI range.
// One buffer can back many CPUs' counters by varying `index`.
const hcBox = new Float64Array(1);
const hc: HcCounter = { box: hcBox, index: 0 };
const bp = new Z80Breakpoints(dbg, hc);

bp.addPcBreak(0x0010, 0x0010, ({ pc }) => {
  console.log(`break @ ${pc.toString(16)}`);
});

// Per-edge loop: clock the dbg, tick the consumer-owned HC, then let
// the bp do its post-edge PC and stepHc scan.
for (;;) {
  dbg.clockEdge();
  hcBox[0]++;
  bp.tickAfterEdge();
}
```

The REPL ([`packages/z80cpu-cli/src/repl.ts`](packages/z80cpu-cli/src/repl.ts))
wires all three together inside a single `tickEdge()` helper — useful as a
reference when adapting the pattern to your own bus loop.

## Repository status

This is a working repo, not a published library set — none of the lab
packages are on npm. The expected use is `git clone` + `npm install`. The
runtime `@dcorp80/z80cpu` dependency resolves from npm in the normal way.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: MIT, SPDX header
on every new file, Biome for style, and don't break the observer-purity
invariant in `z80cpu-debug` (the bench will catch you).

## License

MIT — see [`LICENSE`](LICENSE).
