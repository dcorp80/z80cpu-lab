# @dcorp80/z80cpu-bench

Overhead benchmark for [`@dcorp80/z80cpu-debug`](../z80cpu-debug). Runs the
`mixer.asm` program three ways on the same CPU core and reports the slowdown
the debug wrapper adds:

1. Plain `cpu.clockEdge()` — baseline.
2. `dbg.clockEdge()` with tracing **off** — measures the cost of the wrapper
   itself (PC-break check, totalHc bump) when no trace bookkeeping runs.
3. `dbg.clockEdge()` with tracing **on** — full bookkeeping, callback fires
   per instruction.

Final CPU state (register file + memory SHA-256 + IO SHA-256) is asserted
equal across all three runs. Because `Z80DebugContext` is a pure observer,
any divergence is a bug — this is the regression net for the dbg wrapper.

## Running

```bash
npm test -w @dcorp80/z80cpu-bench
```

The test skips itself if `src/mixer.bin` is missing.

## Regenerating `mixer.bin`

`src/mixer.bin` is `src/mixer.asm` assembled with
[sjasmplus](https://github.com/z00m128/sjasmplus):

```bash
cd packages/z80cpu-bench/src
sjasmplus mixer.asm --raw=mixer.bin
```

The output is ASCII CSV of decimal bytes (the loader auto-detects format),
which keeps it text-diffable in git. Re-run after any edit to `mixer.asm`.

## Tunables

| Env var | Default | Effect |
|---|---|---|
| `MIXER_ITER_COUNT` | `100` | Outer-loop iterations of the mixer program (1..255). Lower = faster run, less JIT warm-up. |
| `MIXER_MAX_HC` | `10_000_000` | Safety budget — bench fails if the sentinel write hasn't fired within this many half-cycles. Raise for very large iter counts. |

## Mixer program

`mixer.asm` is a hand-written Z80 program that exercises a wide cross-section
of the instruction set (documented + undocumented), prefixes, indexed
addressing, block ops, and IO — chosen to stress dbg's byte-capture and
trace-finalization paths. See the header in `src/mixer.asm` for the memory
map and coverage strategy.
