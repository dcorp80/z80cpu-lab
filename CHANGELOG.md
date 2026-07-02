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

## [explorer-0.4.3] — 2026-07-02

Patch release: picks up the latest CPU core fixes.

### `@dcorp80/z80cpu-explorer`

#### Changed
- Bumped `@dcorp80/z80cpu` from `0.2.0` to `0.2.1` across every package that depends on it (`-debug`, `-cli`, `-bench`, and the explorer).

## [explorer-0.4.2] — 2026-06-27

Patch release: picks up the latest CPU core fixes and eliminates layout shifts in the Current opcode display.

### `@dcorp80/z80cpu-explorer`

#### Changed
- Bumped `@dcorp80/z80cpu` from `0.1.3` to `0.2.0` across every package that depends on it (`-debug`, `-cli`, `-bench`, and the explorer).

#### Fixed
- Current opcode display no longer causes layout shifts while running the code.

## [explorer-0.4.0] — 2026-06-23

Focus: interrupt-driven workflows. The bus gains a software-configurable
INT generator (period + pulse width), the App-shell picks up a Light /
Dark / System theme toggle, and a new Rule 30 guided tour walks through
INT-paced cooperative scheduling and the IM 1 acknowledge cycle.

### `@dcorp80/z80cpu-explorer`

#### Added
- **INT generator** wired into the bus and the Interrupts panel — configurable period and pulse width in half-cycles, persisted in the shared HC box slots so it survives cold-starts. Drives `nINT` on a regular cadence without any host-side code.
- **Light / Dark / System theme toggle** in the App-shell. Explicit override or follow OS preference; the chosen mode persists.
- **Rule 30 guided tour** under [`apps/z80cpu-explorer/examples/rule30/`](apps/z80cpu-explorer/examples/rule30/README.md) — pace a 1-D cellular automaton off the INT generator: two cooperative tasks (IM 1 ISR + main producer) on a single Z80 with a race-free row-boundary throttle, then break inside the INT-acknowledge cycle to see IFF1/IFF2 clear and the injected vector byte on the data bus.

## [explorer-0.3.1] — 2026-06-21

Patch release: picks up an upstream CPU bugfix, plus an opt-in toggle
to surface the internal WZ (MEMPTR) latch in the CPU state panel.

### `@dcorp80/z80cpu-explorer`

#### Added
- `SHOW_WZ` flag in [`apps/z80cpu-explorer/src/config/defaults.ts`](apps/z80cpu-explorer/src/config/defaults.ts) (off by default). When enabled, the internal WZ (MEMPTR) latch renders in the IRQ row alongside `IFF1`/`IFF2`/`IM` — useful when chasing the `XF`/`YF` flag bits from `BIT n,(HL)` and block compares, or when writing Z80 test ROMs. No runtime UI toggle; edit + reload.

#### Changed
- Bumped `@dcorp80/z80cpu` from `0.1.2` to `0.1.3` across every package that depends on it (`-debug`, `-cli`, `-bench`, and the explorer) to pick up the upstream CPU bugfix.

## [explorer-0.3.0] — 2026-06-19

Focus: virtualization across the heavy panes (instruction trace, HW
trace, hex grids), address-page pagination for Memory/IO with view
decoupled from the watch address, consolidated trace-capture toggles,
and a tooling refresh (Vitest 4 / Vite 8 / Biome 2.5). One new example
tour ships with the release.

### `@dcorp80/z80cpu-explorer`

#### Added
- RAXOFT z80test guided tour under [`apps/z80cpu-explorer/examples/z80test/`](apps/z80cpu-explorer/examples/z80test/README.md) — load the RAXOFT instruction-correctness ROM and watch it walk the CPU through its suite.
- **Memory/IO column toggles** and a watch-address **Recall** button: the view is now decoupled from the watch address, so you can pan around without losing your watch and snap back with one click.
- HW-trace empty-state hint removed in favour of an always-visible scope; the empty pane reads as "no events yet" without extra chrome.

#### Changed
- **Virtualization across the heavy panes.** Instruction-trace Executed pane, the HW-trace body (ring flattened, horizontal virtualization driven off the rendered spacer width), and the HexGrid all now render only the visible window. HexGrid uses a typed-array page buffer with on-demand `windowSlice`, eliminating per-paint allocations.
- **Memory/IO pagination.** Address-page pagination for the 64K mem view; the 8-bit IO broadcast view is scrollable. `viewPageBase` re-snaps on `pageSize` changes; `*WatchOnView` resets on IO mode flip.
- **Trace toggles consolidated in App-shell.** Trace-instructions controls moved out of the section header into App-shell; capture modes simplified from enums to booleans, with the folded summary derived directly from the boolean.
- Breakpoints: when you edit `lo` above the current `hi`, `hi` clamps up to follow — no more invalid ranges mid-edit.
- Toolchain refresh: Vitest 4, Vite 8, Solid + Playwright bumps, migrated to Biome 2.5.0.
- Cleanup: stripped REQ/DESIGN §-references from in-code comments now that the spec docs are stable.

#### Fixed
- InstructionTrace: corrected `CurrentInstructionSnapshot` type and assorted review nits in the in-flight Current row.
- Dropped orphaned Vitest browser-mode screenshot debris from the repo.

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

[Unreleased]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.4.3...HEAD
[explorer-0.4.3]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.4.2...explorer-v0.4.3
[explorer-0.4.2]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.4.1...explorer-v0.4.2
[explorer-0.4.1]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.4.0...explorer-v0.4.1
[explorer-0.4.0]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.3.1...explorer-v0.4.0
[explorer-0.3.1]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.3.0...explorer-v0.3.1
[explorer-0.3.0]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.2.0...explorer-v0.3.0
[explorer-0.2.0]: https://github.com/dcorp80/z80cpu-lab/compare/explorer-v0.1.0...explorer-v0.2.0
[explorer-0.1.0]: https://github.com/dcorp80/z80cpu-lab/releases/tag/explorer-v0.1.0
