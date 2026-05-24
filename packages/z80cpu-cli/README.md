# @dcorp80/z80cpu-cli

Interactive shell around `Z80Cpu` + `Z80DebugContext` + disassembler. One
program loads at $0000; you step it half-cycle by half-cycle, or skip / run
to a breakpoint.

```
z80cpu-repl <path>              # when installed
node packages/z80cpu-cli/dist/repl.js <path>
```

`<path>` is either a raw binary or an ASCII CSV of decimal bytes.

## Commands

| Input            | Effect |
|------------------|--------|
| `<enter>`        | Step until the next trace fires (one instruction, or one wasted prefix M1). Prints the trace line followed by the full register snapshot. |
| `<integer N>`    | Fast-forward `N` half-cycles with tracing OFF. The last ~96 HC re-enable tracing so you see context where you stopped. |
| `b <addr>`       | Set a PC breakpoint at `<addr>` (hex). Replaces any existing breakpoint. |
| `b <lo> <hi>`    | Set a PC range breakpoint, inclusive on both ends. |
| `b`              | Show the current breakpoint. |
| `b -`            | Clear the breakpoint. |
| `c`              | Continue: free-run (tracing off) until the breakpoint fires. Requires a breakpoint to be set. |
| `exit` / Ctrl-D  | Quit. |

Hex address forms: bare (`1234`), `0x` prefix (`0x1234`), or `$` prefix
(`$1234`). All in the 16-bit range $0000..$FFFF.

## Breakpoint semantics

A PC breakpoint fires when the CPU is **about to fetch** an opcode at an
address inside the range — i.e. at the start of an M1 cycle with `PC ∈
[lo, hi]`. Execution stops **before** the opcode at that address runs, so:

- `dbg.state().pc` shows the breakpoint address.
- The instruction at that address has not yet executed (registers reflect
  the *previous* instruction's completion).
- The next `<enter>` step executes the instruction and prints its trace.

The breakpoint is sticky: hitting it does not disarm it. If the program
loops back through the range, the next `c` will stop again. Use `b -` to
clear.

Data accesses to an address inside the range do **not** fire — this is an
execution breakpoint, not a watchpoint. (gdb/lldb behave the same way.)

## Example session

```text
loaded 32 bytes from prog.csv
commands: <enter>=step one trace, <N>=skip N HC (tracing off), exit=quit
z80> b 0010
breakpoint set at 0010h
z80> c
(break at 0010)
  PC=0010  SP=FFFE  IX=0000  IY=0000  WZ=000F
  AF=4200 BC=0000 DE=0000 HL=0000  F=........
  ...
z80> 
0010  3A 34 12       LD A,(1234h)              13T  → 1234h
  PC=0013  SP=FFFE  ...
z80> b -
breakpoint cleared
z80> exit
```
