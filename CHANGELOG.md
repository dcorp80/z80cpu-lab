# Changelog

All notable changes to this monorepo are recorded here.

This is a single root changelog because the only release artifact in the
repo is `@dcorp80/z80cpu-explorer`, deployed to GitHub Pages by the
`explorer-v*` tag trigger in [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
The library packages (`z80cpu-debug`, `z80cpu-disasm`, `z80cpu-cli`,
`z80cpu-bench`) are not published to npm; their changes ride along with
the explorer release. If a package starts cutting its own versions, it
should spin out its own `CHANGELOG.md` at that point.

Each release entry is sectioned by package. Versions follow
[Semantic Versioning](https://semver.org/) and headings follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

_Nothing yet._

## [explorer-0.2.0] — 2026-06-13

First release since the initial GH Pages deploy. Focus: pre-deploy
polish, an IndexedDB storage backend for large mem/IO snapshots, a hot-
path GC reduction in the run loop, and a guided Mandelbrot tour.

### `@dcorp80/z80cpu-explorer`

#### Added
- Mandelbrot guided tour under [`apps/z80cpu-explorer/examples/mandelbrot/`](apps/z80cpu-explorer/examples/mandelbrot/README.md) — load a binary, single-step, set HC and PC breakpoints, watch the picture fill in, and service an NMI against the halted CPU.
- Instruction-trace **Capture** toggle. Paused-only, mirroring the existing HW-trace Capture behavior — keeps trace overhead off the hot path when you don't need history.
- In-flight **Current** row in the instruction trace, plus a stable preview origin so PREVIEW (NEXT AT PC) doesn't scroll on every step.
- IndexedDB storage backend (in addition to localStorage and in-memory). Picked automatically for snapshots that exceed the localStorage budget; App-shell now also exposes the mem/IO fill bytes used on Cold Start.

#### Changed
- Run-loop hot path reworked to reduce GC sawtooth across the per-edge and per-instruction callbacks. Allocations moved off the inner loop; the HC stamp is now passed by `Float64Array` ref through `onInstruction` to avoid per-call boxing.
- `createAppStore` is now wrapped in `createRoot`, so the store has an owner for `createEffect`s and tests can dispose cleanly between cases.

#### Fixed
- Pre-deploy bug sweep covering REQ §12 noticed-issues and §13 review findings — touched boot, hotkey dispatch, breakpoints, HW-trace, run loop, hex inputs, hex grid, IO port grid, store, and styles. See commit `e896eba` for the full list.
- Breakpoints browser test isolated from sibling tests' DOM state.

### `@dcorp80/z80cpu-debug`

#### Changed
- **Breakpoints and HC counter split out of `Z80DebugContext`** into standalone classes (`Z80Breakpoints`, `HcCounter`). They were always logically separable observers; the explorer needs independent lifetimes for each, and the CLI now composes them explicitly. The package index re-exports the new types alongside the existing `Z80DebugContext`, so consumer code that only used the context keeps working.
- Internal cleanups to support the explorer's GC-sawtooth reduction without changing the observer-purity invariant. The bench still asserts plain / dbg-on / dbg-off produce identical final state.

## [explorer-0.1.0] — 2026-06-09

First deployment of the visual explorer to GitHub Pages.

### `@dcorp80/z80cpu-explorer`

#### Added
- Initial app: Solid.js + Vite SPA, sectioned UI with foldable, drag-to-reorder, persistent layout.
- Sections: Program, Breakpoints, CPU state, Memory, Instruction trace, IO, Hardware trace, Interrupts, App-shell.
- Run loop driving `cpu.clockEdge()` half-cycle by half-cycle, paired with a 64K mem + 64K IO bus (`src/runloop/bus.ts`) that also injects the INT-ack vector and edge-triggers `nNMI`.
- Hardware trace: half-cycle-resolution oscilloscope of bus pins, M1 gridlines, refresh dimming, click-to-assert input pins (`nINT`, `nNMI`, `nRESET`, …).
- Breakpoints: PC-range and HC-count, Run / Pause, effective emulated MHz indicator, click-to-BP from address grids.
- IO section: 64K port grid, 256-port 8-bit broadcast view, optional split RD/WR planes.
- Memory section: 64K hex grid with watch address, ASCII column, in-place editing, configurable bytes-per-row.
- Storage: localStorage + in-memory backends behind a pluggable interface; autoload on boot.
- Header version chip showing `v<version> (<sha>)` baked in at build time.
- GitHub Pages deployment via tag-triggered workflow (`explorer-v*` → `gh-pages`).

[Unreleased]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.2.0...HEAD
[explorer-0.2.0]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.1.0...explorer-v0.2.0
[explorer-0.1.0]: https://github.com/dcorp80/z80cpu-lab/releases/tag/explorer-v0.1.0
