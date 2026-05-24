# Contributing to z80cpu-lab

Bug reports, fixes, new tests, and disassembler-style tweaks are welcome.
A few ground rules.

## License

Everything in this repo is **MIT** ([LICENSE](LICENSE)). Each source file
carries an SPDX header:

```ts
// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80
```

…or the equivalent line-comment form for `.asm` (`;`). New files must carry
the header. By submitting a pull request, you agree to license your
contribution under MIT. No CLA — submitting the PR is the agreement.

## Workflow

```bash
npm install             # resolves @dcorp80/z80cpu from npm
npm test                # full suite — node:test, runs TS directly (Node 24+)
npm run lint            # Biome — check only
npm run lint:fix        # Biome — apply fixes
npm run build           # builds the CLI bundle (only z80cpu-cli has a build)
```

Single test file:

```bash
node --test packages/z80cpu-debug/src/z80cpu-dbg.test.ts
```

Node 24+ is required — the test command relies on native TypeScript stripping
(unflagged since Node 23.6) and the import-from-`.ts` ergonomics in
`tsconfig.base.json`.

## Tests

- Every behavioural change needs a test. Test files live next to source as
  `*.test.ts` and use Node's built-in `node:test` — no framework.
- New `z80cpu-debug` behavior: a focused `*.test.ts` mirroring the style of
  `z80cpu-dbg.test.ts`.
- New disassembler encoding: add a case to the appropriate suite in
  `packages/z80cpu-disasm/src/z80disasm.test.ts`.
- The bench suite (`@dcorp80/z80cpu-bench`) is also part of `npm test`. It
  enforces the **observer-purity invariant**: see below.

## The observer-purity invariant (read before touching z80cpu-debug)

`Z80DebugContext` wraps `Z80Cpu` as a pure observer. The CPU must execute
identically whether `dbg.clockEdge()` is called instead of `cpu.clockEdge()`,
and whether `dbg.enabled` is `true` or `false`. The bench enforces this by
running the mixer program three ways and asserting register + memory + IO
SHA-256 equality at the end.

If you change anything in `packages/z80cpu-debug/src/z80dbg.ts` and the
bench's `deepStrictEqual` fails, you've introduced a side effect on the CPU
— not a bench bug. Fix the wrapper.

## The trace timing footgun

The `onInstructionComplete` callback fires at `m1_t3_1` of the *next*
instruction's M1 — not at the end of the instruction being reported. This
is forced by the Z80 committing deferred A/F writes at the next M1's T2_1.

Practical consequence: `dbg.state().pc === trace.nextPc + 1` for the
just-completed instruction (the next M1's T1_1 has already incremented PC
by the time the callback runs). Use `trace.nextPc` for "PC after this
instruction"; use `state().pc` for the live register file.

Full table and rationale in
[`packages/z80cpu-debug/README.md`](packages/z80cpu-debug/README.md#timing--when-does-the-callback-fire).
Read it before changing the capture switch in `z80dbg.ts`.

## Style

- 2-space indentation (`.ts`), enforced by Biome.
- Double-quoted strings, organized imports — also enforced by Biome.
  `npm run lint:fix` will sort things out.
- No comments explaining *what* the code does — names should already say
  that. Comment only the *why* of non-obvious choices.
- No unnecessary abstractions or "future-proofing." A bug fix doesn't need
  surrounding cleanup; three similar lines is better than a premature helper.
- `strictNullChecks: false` is repo-wide — don't switch it on per-file.

## Reporting bugs

Open an issue with:

- For dbg/trace bugs: a minimal Z80 program (raw bytes or `sjasmplus`-friendly
  asm) that reproduces the divergence, plus the expected vs. observed trace.
  If the divergence is from the real CPU, include what `@dcorp80/z80cpu`
  produces standalone for comparison — that pinpoints whether it's a CPU
  bug or a dbg bug.
- For disassembler bugs: the input bytes and the expected mnemonic. Cite a
  reference (Zilog manual page, ZX docs, undocumented-opcode table) where
  useful.
- For REPL bugs: the program file, the exact command sequence, and what you
  saw vs. expected.
