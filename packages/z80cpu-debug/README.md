# @dcorp80/z80cpu-debug

Instruction tracing and debug context for [`@dcorp80/z80cpu`](https://www.npmjs.com/package/@dcorp80/z80cpu).

Wraps `Z80Cpu` as a pure observer — same clock-edge protocol, no behavioural
change. Surfaces each completed instruction (or wasted prefix M1) as an
`InstructionTrace` with bytes, M1 type, half-cycle count, and the logical
next-PC; offers PC-range breakpoints, step-by-half-cycle one-shots, and an
architectural-register snapshot via the underlying CPU.

## Install

```bash
npm install @dcorp80/z80cpu @dcorp80/z80cpu-debug
```

## Usage

```ts
import { Z80Cpu } from "@dcorp80/z80cpu";
import { Z80DebugContext } from "@dcorp80/z80cpu-debug";

const cpu = new Z80Cpu();
const dbg = new Z80DebugContext(cpu);

dbg.onInstructionComplete = (t) => {
    const bytes = t.bytes.slice(0, t.length).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    console.log(`${t.startAddr.toString(16)}: ${bytes}  ${t.hc >> 1}T  next=${t.nextPc.toString(16)}`);
};

// Drive dbg.clockEdge() instead of cpu.clockEdge()
for (;;) dbg.clockEdge();
```

## API

### Trace lifecycle

- `dbg.onInstructionComplete: (trace) => void` — fires once per instruction
  after the deferred A/F writes have landed. See **Timing** below.
- `dbg.curr` / `dbg.prev` — the in-flight and just-finalized traces. Double-
  buffered; consumers should copy out anything they want to keep, since these
  are reused. Reading `dbg.curr` mid-instruction is supported (visual debuggers
  use it for "what's running right now"): `bytes[0..length)` reflect what the
  CPU has fetched so far, `m1Type` is set at the M1 start, and `nextPc` is
  seeded to `startAddr` until the next M1's T1_0 overwrites it with the real
  next-instruction address.

### Snapshots

- `dbg.state(out?)` — convenience pass-through to `cpu.snapshot(out)` from
  `@dcorp80/z80cpu`. Returns a `CpuState` with decoded `main`/`alt` register
  banks, IM, IFFs, and NMI-pending. Pass an `out` buffer to avoid per-call
  allocation in tight loops.

### Stepping

- `dbg.stepHc(n, cb, prefetchHc?)` — one-shot trigger that fires `cb` after
  exactly `n` half-cycles. If `dbg` was disabled, it's auto-enabled
  `prefetchHc` HC (default 96) before the target so the surrounding
  instructions are observed cleanly.

### PC breakpoints

- `dbg.addPcBreak(lo, hi, cb): BreakHandle` — fire `cb({pc, lo, hi})` at the
  next M1 boundary where PC enters `[lo, hi]`. Edge-triggered (one fire per
  instruction execution at a matching address). Auto-enables the dbg on fire.
  Returned handle has `.remove()`.
- `dbg.clearAllPcBreaks()`, `dbg.listPcBreaks()`.

### Enable / disable

- `dbg.enabled` (get/set) — disabling skips all trace bookkeeping but keeps
  `totalHc` and the PC-breakpoint check running, so free-run + breakpoint
  works. Toggling false → true discards any in-flight trace state.
- `dbg.totalHc` — global half-cycle counter, always advances.

### Types

`InstructionTrace`, `M1Type`, `PcBreakInfo`, `BreakHandle`, and (re-exported
from `@dcorp80/z80cpu`) `CpuState`, `DecodedFlags`, `decodeFlags`.

## InstructionTrace shape

```ts
class InstructionTrace {
    startAddr: number;         // PC at the M1 that started this instruction
    bytes: number[];           // length-prefixed opcode + operand bytes
    length: number;
    m1Type: M1Type;            // 'normal' | 'nmi' | 'int' | 'halt' | 'special_reset'
    hc: number;                // half-cycles end-to-end; T-states = hc >> 1
    nextPc: number;            // logical "where the CPU went next"
}
```

`hc` is half-cycles. Every Z80 cycle is exactly 2 HC, so the conventional
T-count is `t.hc >> 1`.

## Timing — when does the callback fire?

The trace callback fires at **`m1_t3_1` of the *next* instruction's M1**.
This is unavoidable: the Z80 commits deferred A/F register writes at the
next M1's T2_1, so any earlier reporting would expose stale A/F values.

By the time the callback runs, the CPU has already executed several steps
of the next M1:

| Step                | Effect                                                |
| ------------------- | ----------------------------------------------------- |
| `m1_t1_0` (next M1) | Asserts `/M1`, drives bus.addr = PC = next-instr addr |
| `m1_t1_1`           | **`PC ← PC + 1`** (PC is incremented mid-fetch)       |
| `m1_t2_0/1`         | Refresh phase; **deferred A/F from prev landed at T2_1** |
| `m1_t3_0`           | Internal trace bookkeeping (prev swapped, curr seeded) |
| `m1_t3_1`           | **callback fires**                                    |

Two consequences for what consumers see:

**`trace.startAddr`** — the PC at *this* trace's own M1 t1_0, i.e. the address
where this instruction was fetched. Always correct.

**`trace.nextPc`** — the PC at the *next* M1's t1_0, captured *before* the
T1_1 increment. This is the logical "where the CPU goes next" — covers
sequential flow, jumps, calls, rets, RST, and NMI/INT redirects.
On `dbg.curr` (in-flight reads) `nextPc` is pre-seeded to `startAddr` and
holds that until the next M1's T1_0 overwrites it; on the trace handed to
`onInstructionComplete` the value is always the real next-M1 address.

**`dbg.state().pc`** — reads `cpu.regs.pc` live. At callback time the next
M1's T1_1 has already incremented it, so for the just-completed instruction
`state().pc === trace.nextPc + 1`. This is the *real* mid-fetch CPU state —
matches what you'd see on the silicon — not a logical-end-of-instruction
view. Use `trace.nextPc` when you want "PC after this instruction"; use
`state().pc` when you want the actual register file.

The same offset applies whenever `onInstructionComplete` fires — including
NMI and INT traces (the next M1 there is the handler's first M1).

## How byte capture works

Capture keys off step-function identity rather than bus edges, so the trace
correctly attributes bytes to opcode vs operand vs internal vs IO cycles. NMI,
INT, HALT, and special-reset M1 types are tagged. Wasted prefix M1s (DD DD,
DD FD, …) surface as their own short traces — useful for diagnosing
mis-prefixed code. NMI traces still record the discarded refresh-fetch byte;
consumers filter by `m1Type`.
