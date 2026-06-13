# @dcorp80/z80cpu-explorer

Browser-based visual debugger and tracer for [`@dcorp80/z80cpu`](https://www.npmjs.com/package/@dcorp80/z80cpu).
Loads a Z80 program, drives the CPU half-cycle by half-cycle, and shows
every internal you'd want — instruction trace, register file, memory and
IO grids, and a hardware-pin waveform — side by side and live.

**Live demo:** [dcorp80.github.io/z80cpu-lab](https://dcorp80.github.io/z80cpu-lab/)

**Guided tour:** [Mandelbrot example](examples/mandelbrot/README.md) — a 7-step walkthrough that loads a binary, single-steps through fetch/execute, sets HC and PC breakpoints, watches a Mandelbrot fill in, and services an NMI against the halted CPU.

## What's in it

A single page split into foldable, reorderable sections:

| Section | What it shows |
|---|---|
| **App-shell** | App name, version, Cold-boot button; Split-RD/WR-IO toggle. |
| **Program** | Load one or more files into memory at chosen addresses; autoload on boot. |
| **Breakpoints** | PC-range and HC-count breakpoints; Run / Pause; effective emulated MHz. |
| **CPU state** | Live register file, flags as bits, IFF1/IFF2, IM, shadow set. |
| **Memory** | 64K hex grid with watch address, ASCII column, in-place editing. |
| **Instruction trace** | Disassembled history of every completed instruction; next-at-PC preview; step / step-N. |
| **IO** | 64K port grid (or 256-port 8-bit view); split RD/WR planes optional. |
| **Hardware trace** | Half-cycle-resolution oscilloscope of bus pins (nM1, nMREQ, nRD, nWR, …) plus the address/data buses; assert input pins (nINT, nNMI, nRESET, …) by clicking. |
| **Interrupts** | INT-acknowledge vector byte. |

## Quick start

From the repo root:

```bash
npm install
npm run dev -w @dcorp80/z80cpu-explorer
```

Vite opens a tab at `http://localhost:5173/`. Edits hot-reload.

```bash
# Production build → apps/z80cpu-explorer/dist/
npm run build -w @dcorp80/z80cpu-explorer
# Preview the built bundle
npm run preview -w @dcorp80/z80cpu-explorer
```

The bundle is a static SPA — drop `dist/` on any static host (S3, GitHub
Pages, Netlify) and it runs.

## Tests

Two-project Vitest setup:

```bash
# Both tiers
npm test -w @dcorp80/z80cpu-explorer
# Just the fast happy-dom unit tier
npm test -w @dcorp80/z80cpu-explorer -- --project unit
# Watch mode
npm run test:watch -w @dcorp80/z80cpu-explorer
```

The **unit** tier (happy-dom) covers most logic and renders. The
**browser** tier (Playwright/Chromium, files named `*.browser.test.tsx`)
covers the few cases happy-dom can't fairly simulate — HTML5
drag-and-drop, real `document.activeElement`, paint/rAF. First-time
browser-tier setup needs `npx playwright install chromium`.

## How it's built

- **Solid.js** for fine-grained reactivity (a single `store` exposes
  signals; sections subscribe directly to the slices they read).
- **Vite** for dev server + production bundle.
- **`@dcorp80/z80cpu`** is the CPU core; **`@dcorp80/z80cpu-debug`** is
  the tracing observer; **`@dcorp80/z80cpu-disasm`** disassembles the
  byte windows the trace reports.
- The **RunLoop** drives `cpu.clockEdge()` paired with a 64K mem + 64K
  IO bus (`src/runloop/bus.ts`) that also injects the INT-ack vector.
- User-facing copy is centralized in `src/style/strings.ts`; visual
  styling for the disassembler lives in `src/style/disasmStyle.ts`.

## Version display

The header chip shows `v<version> (<sha>)`, where `<version>` comes from
`apps/z80cpu-explorer/package.json` and `<sha>` is `git rev-parse --short
HEAD` baked in at build time (Vite `define`). When `git` isn't available
the SHA falls back to `"dev"`.

## Position in the monorepo

This app is downstream of every package in [`packages/`](../../packages).
See the [root README](../../README.md) for the CPU / debug / disasm /
CLI / bench overview, and [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for
style and licensing.

## License

MIT — see [`../../LICENSE`](../../LICENSE).
