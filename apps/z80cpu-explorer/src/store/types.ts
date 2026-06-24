import type { CpuState } from "@dcorp80/z80cpu";
import type { M1Type } from "@dcorp80/z80cpu-debug";
import type { Accessor } from "solid-js";
import type { Store as SolidStore } from "solid-js/store";
import type { IntGenConfig, UiConfig } from "../config/defaults.ts";
import type { BusAccessRecord, InputPinName } from "../runloop/bus.ts";
import type { HwTraceBuffer } from "../runloop/hwTrace.ts";
import type { PauseReason, RunStatus } from "../runloop/loop.ts";
import type {
  Breakpoint,
  ProgramFile,
  ProgramFileSession,
  SectionUiState,
} from "../storage/types.ts";
import type { Theme } from "../style/theme.ts";
import type { TraceRing } from "./traceRing.ts";

export type { IntGenConfig, UiConfig } from "../config/defaults.ts";
export type { BusAccessRecord } from "../runloop/bus.ts";
// Re-export so loop / sections can import BP-related types from a single
// hub (the store) without reaching into storage internals.
export type { Breakpoint } from "../storage/types.ts";
export type { Theme } from "../style/theme.ts";
export type { TraceRecord, TraceRing } from "./traceRing.ts";

/**
 * Per-section view cursor. `live` = follow the head of
 * the underlying buffer; `detached` = pinned at the given HC, ignoring
 * new appends until the user snaps back to live.
 */
export type ViewCursor =
  | { mode: "live" }
  | { mode: "detached"; anchorHc: number };

/**
 * Cursor slice — one entry per traced section. Both
 * cursors default to `live` on boot and snap back to `live` on
 * `zeroHC` (rebased HC counter would invalidate any pinned anchor).
 * The `g` hotkey + section snap-to-live buttons drive these.
 */
export interface CursorsState {
  instructionTrace: ViewCursor;
  hwTrace: ViewCursor;
}

/**
 * Reactive mirror of the bus's input-pin state.
 * The bus is authoritative (see [[feedback-bus-owns-state]]); this
 * SolidStore copy exists so HW-trace checkboxes + the Interrupts section
 * re-render when the user edits a value. `setInputPin` keeps both in
 * sync; `loop.onTick` re-syncs after every frame to catch nNMI's
 * auto-clear (see [[feedback-nmi-pulse-semantics]]).
 *
 * Naming matches the pin names on `cpu.bus` so callers stay in one
 * vocabulary across the bus + store + UI.
 */
export interface InputPinsState {
  nINT: 0 | 1;
  nNMI: 0 | 1;
  nRESET: 0 | 1;
  nBUSRQ: 0 | 1;
  nWAIT: 0 | 1;
  /** Byte placed on `cpu.bus.data` during INT-acknowledge cycles. */
  intVector: number;
}

/**
 * Snapshot of the in-flight instruction, copied out of `dbg.curr` at
 * pause time. `bytes` holds exactly `length` entries (0..4); the rest
 * of the encoding is unknown until further M-cycles run.
 *
 * `nextPc` is always meaningful: `_initFreshCurr` seeds it to
 * `startAddr` at this trace's own M1 T3_0, and the next M1's T1_0
 * overwrites it with the real next-instruction fetch address. Used as
 * the preview-pane origin so it doesn't slide through operand fetches.
 */
export interface CurrentInstructionSnapshot {
  startAddr: number;
  bytes: readonly number[];
  length: number;
  m1Type: M1Type;
  nextPc: number;
}

/** Input to `addFile` — id is generated, lastLoadedAddr lives in sessions. */
export interface NewProgramFile {
  name: string;
  bytes: Uint8Array;
  loadAddr: number;
  autoload?: boolean;
}

/**
 * Input to `addBreakpoint` — id is store-assigned, `enabled` defaults
 * to true. Splitting by `kind` keeps the per-kind required fields
 * type-checked.
 */
export type NewBreakpoint =
  | { kind: "pc-range"; lo: number; hi: number; enabled?: boolean }
  | { kind: "hc-count"; target: number; enabled?: boolean };

/**
 * Patch shape for `editBreakpoint`. Fields not relevant to the BP's
 * kind are ignored at the store boundary. Kind itself cannot change
 * via edit — that would be a different BP entirely; users delete + add.
 * `enabled` flips via `toggleBreakpoint`, never through this patch.
 */
export type BreakpointPatch = Partial<{
  lo: number;
  hi: number;
  target: number;
}>;

export interface Store {
  // ── UI state
  readonly sections: SolidStore<SectionUiState[]>;
  toggleSectionFold(id: string): void;
  reorderSections(orderedIds: string[]): void;
  updateSectionConfig(id: string, patch: Record<string, unknown>): void;

  // ── run state
  readonly status: Accessor<RunStatus>;
  /**
   * `status() === "paused"` lifted to its own accessor so sections,
   * hotkeys, and store actions share one predicate. If pause semantics
   * ever broaden (e.g. treating `stepping` as "safe to act"), this is
   * the only place that changes.
   */
  readonly isPaused: Accessor<boolean>;
  readonly hc: Accessor<number>;
  /**
   * Raw per-instruction counter.
   *
   * **Non-reactive**: backed by a closure-variable, not a Solid signal.
   * The reactive wiring through Solid would cost a setter closure +
   * equalFn comparator on every instruction (~10⁵–10⁶ Hz at full
   * speed), which surfaced as GC sawtooth in the profiler. The type
   * is `Accessor<number>` only because that's `() => number` in Solid
   * — reading it in a reactive scope will NOT cause re-runs.
   *
   * UI consumers MUST subscribe to `insnCountThrottled` instead. Tests
   * read this accessor non-reactively to assert per-instruction state.
   */
  readonly insnCount: Accessor<number>;
  /**
   * rAF-coalesced mirror of `insnCount` for UI consumers. While
   * running, the raw `insnCount` ticks per instruction (~10⁵–10⁶
   * Hz at full speed); section render paths read this instead so
   * the BP status line and the trace folded summary don't repaint
   * the DOM hundreds of thousands of times per second. Flushed
   * synchronously on pause (including step-pauses) and on zeroHC,
   * matching `traceRingVersionThrottled`.
   *
   * This IS a Solid signal — reactive subscribers belong here, not on
   * `insnCount`.
   */
  readonly insnCountThrottled: Accessor<number>;
  readonly lastPauseReason: Accessor<PauseReason | null>;

  /**
   * Effective clock-speed indicator: host throughput expressed
   * as an emulated Z80 T-state clock (MHz). Measured frame-to-frame in the
   * loop's `onTick` from `(hc, now)` deltas, guarded to a sane dt band so
   * idle / sub-resolution frames don't skew it. `null` before the first
   * valid measurement and after `zeroHC` (the view shows "—"); the last
   * value is held across a pause (the view greys it).
   */
  readonly effectiveClockMHz: Accessor<number | null>;

  // ── CPU state. Sampled on every pause; the boundary flag
  // is true only when the pause landed exactly on M1_T3_1 (then the
  // register file is fully valid and the section paints diff highlights;
  // otherwise it dims to signal "transitional state").
  readonly cpuState: Accessor<CpuState>;
  readonly prevCpuStateAtBoundary: Accessor<CpuState>;
  readonly atInstructionBoundary: Accessor<boolean>;
  /**
   * Snapshot of the in-flight instruction at the moment of pause —
   * the M1 has begun fetching but its `onInstructionComplete` hasn't
   * fired yet. `null` at cold boot (no M1 has run) and whenever the
   * pause didn't land mid-instruction. The InstructionTrace section
   * renders this between Executed and Preview with a `>` gutter
   * marker; preview rows below stay anchored to the last completed
   * trace's `nextPc` so they don't slide through operand fetches.
   *
   * Sampled by copy on `onPause` (NOT on every `onInstruction` — that
   * would be a Solid write on the hot path).
   */
  readonly currentInstruction: Accessor<CurrentInstructionSnapshot | null>;

  run(): void;
  pause(): void;
  stepInstructions(n: number): void;
  stepHC(n: number): void;
  zeroHC(): void;
  /**
   * Cold-boot the explorer: full page reload — fresh CPU,
   * mem, IO; persisted files / breakpoints / layout survive; autoload
   * re-fires. Paused-only; silently no-ops while running so a held hotkey
   * doesn't yank an active CPU mid-frame. Single owner of the policy so
   * the App-shell button, Shift+R hotkey, and post-Save reload share one
   * gate (eventually a save-or-skip modal — M8c).
   */
  coldBoot(): void;

  // ── HW trace (M8a — outputs only). The buffer itself is
  // exposed for the section's `rangeView` queries; `hwTraceVersion`
  // bumps each frame that recorded any transitions, so consumers'
  // createMemo re-runs without polling. `hwTraceCapture` mirrors
  // `buffer.getEnabled()` reactively. Cursors and the throttled mirror
  // land in later M8a sub-tasks alongside the section UI.
  readonly hwTrace: HwTraceBuffer;
  readonly hwTraceVersion: Accessor<number>;
  /**
   * Whether the HW-trace ring captures per-edge bus snapshots. Mirrors
   * the InsnTrace `capture` toggle in shape (boolean) — disabling clears
   * the ring + snaps the cursor to live. Persisted under the `hwTrace`
   * section config as `capture: boolean`. Defaults to `true`. Paused-only.
   */
  readonly hwTraceCapture: Accessor<boolean>;
  setHwTraceCapture(v: boolean): void;

  // ── instruction trace. Ring is the canonical buffer;
  // `traceRingVersion` bumps on push/clear; `traceRingVersionThrottled`
  // is the reactive mirror sections subscribe to — rAF-debounced
  // during run, flushed immediately on pause-edge (trace
  // panes batch appends while running, flush on the next paint). When
  // the loop is already paused, the throttle is bypassed so step-pause
  // and tests observe updates synchronously.
  readonly traceRing: TraceRing;
  /**
   * Raw per-push version counter.
   *
   * **Non-reactive** — same rationale as `insnCount`. Backed by a
   * closure variable; reading it in a reactive scope will NOT re-run.
   * UI consumers MUST use `traceRingVersionThrottled`. Tests read
   * this non-reactively to assert push/clear bumps.
   */
  readonly traceRingVersion: Accessor<number>;
  /** Reactive mirror of `traceRingVersion` — Solid signal. UI memos
   *  belong here. */
  readonly traceRingVersionThrottled: Accessor<number>;
  /**
   * Whether the instruction-trace ring captures completed instructions
   *. `true` pushes each completed instruction; `false` skips
   * the push entirely. Going `true` → `false` clears the ring (consistent
   * with `setHwTraceCapture`) — a save/export prompt will land here later.
   * Implies `traceInstructions === true`: turning capture on while tracking
   * is off auto-enables tracking; turning tracking off auto-disables
   * capture. Defaults to `true`. Paused-only.
   */
  readonly capture: Accessor<boolean>;
  setCapture(v: boolean): void;
  /**
   * Whether the dbg observer is active (`dbg.enabled`). When `false`,
   * `clockEdge` skips all per-edge trace bookkeeping — the
   * `onInstructionComplete` callback never fires, so step-by-instruction
   * is unavailable and the Current / Preview rows are suppressed. PC- and
   * HC-range breakpoints run independently of this. Paused-only. Persisted
   * under the `appShell` section. Defaults to `true`.
   */
  readonly traceInstructions: Accessor<boolean>;
  setTraceInstructions(v: boolean): void;
  /**
   * Whether consecutive identical-PC instructions (LDIR, HALT, JR $) are
   * folded into one ring record with a `count` field rather than filling
   * the ring with duplicate entries. Default `true`. Paused-only. Flipping
   * in either direction clears the ring (mixed folded/unfolded records in
   * the same ring would be ambiguous). Persisted under `appShell`.
   */
  readonly collapseRepeats: Accessor<boolean>;
  setCollapseRepeats(v: boolean): void;

  // ── view cursors. Default `live`; detached
  // by scroll-back; snap-to-live button (and `g` hotkey, which snaps
  // both at once) reattaches.
  readonly cursors: SolidStore<CursorsState>;
  detachInstructionTraceCursor(anchorHc: number): void;
  snapInstructionTraceCursorToLive(): void;
  detachHwTraceCursor(anchorHc: number): void;
  snapHwTraceCursorToLive(): void;

  // ── memory & IO read/write. Sections read through
  // `memByte` / `ioByte`; the createMemo tracking the matching version
  // signal re-runs after writes. `setMemByte` / `setIoByte` are
  // paused-only — calls during run no-op.
  memByte(addr: number): number;
  readonly memVersion: Accessor<number>;
  setMemByte(addr: number, value: number): void;
  ioByte(addr: number): number;
  readonly ioVersion: Accessor<number>;
  setIoByte(addr: number, value: number): void;
  /**
   * 8-bit-decoded IO write. Writes `value` to all 256
   * high-byte aliases of `port` in the RD plane so subsequent CPU
   * reads return the same value regardless of the upper address byte.
   * `port` is 0..0xFF; out-of-range throws `RangeError`. Paused-only;
   * calls during run no-op (same gate as `setIoByte`).
   */
  setIoBytePort8(port: number, value: number): void;

  /**
   * WR-plane read paths (split-IO mode). The IO section's
   * second pane renders these. In joined mode (`splitIo() === false`)
   * the WR plane is not allocated; `ioByteWrite` returns 0 and the
   * pane is hidden — consumers must gate on `splitIo()`.
   * `ioVersionWrite` bumps on each pause (the run that just ended
   * may have OUTed) and on zeroHC. No user setter — the WR plane is
   * a passive record of what the program emitted, not an input.
   */
  ioByteWrite(addr: number): number;
  readonly ioVersionWrite: Accessor<number>;
  readonly ioWatchAddrWrite: Accessor<number>;
  setIoWatchAddrWrite(addr: number): void;
  readonly ioWatchJumpVersionWrite: Accessor<number>;
  requestIoWatchJumpWrite(): void;

  // ── bus last-touched for folded summaries. Sampled
  // from the bus on every `loop.onPause`, so they reflect what the
  // CPU did before pausing — frozen during run per §7.5. `null` until
  // the corresponding cycle has occurred at least once.
  readonly lastMemRead: Accessor<BusAccessRecord | null>;
  readonly lastMemWrite: Accessor<BusAccessRecord | null>;
  readonly lastIoRead: Accessor<BusAccessRecord | null>;
  readonly lastIoWrite: Accessor<BusAccessRecord | null>;

  // ── watch-window state (M7). The Memory and IO sections each render
  // a fixed window of rows centered on a user-typed address. Watch
  // address persists via `SectionUiState.config.watchAddr` so reload
  // restores the user's view. The `*JumpVersion` signals bump every
  // time the user presses Enter on the watch input; the section body
  // listens and scrolls the watch row back into view, even if the
  // address itself didn't change.
  readonly memWatchAddr: Accessor<number>;
  setMemWatchAddr(addr: number): void;
  readonly memWatchJumpVersion: Accessor<number>;
  requestMemWatchJump(): void;
  readonly ioWatchAddr: Accessor<number>;
  setIoWatchAddr(addr: number): void;
  readonly ioWatchJumpVersion: Accessor<number>;
  requestIoWatchJump(): void;

  /**
   * View-page-base — which page is currently displayed in the section
   * body. Distinct from `watchAddr` so page-nav buttons can move the
   * view without disturbing the marker. Not persisted (view state, not
   * config); boots from `pageBase(watchAddr, pageSize)`. Setter masks
   * to 16-bit and snaps to the current page alignment.
   */
  readonly memViewPageBase: Accessor<number>;
  setMemViewPageBase(addr: number): void;
  readonly ioViewPageBase: Accessor<number>;
  setIoViewPageBase(addr: number): void;
  readonly ioViewPageBaseWrite: Accessor<number>;
  setIoViewPageBaseWrite(addr: number): void;

  /**
   * `*WatchOnView` — true when the watched address is currently
   * visible in the section body (its page is the one shown AND its
   * row is within the scroll viewport). HexGrid drives the signal
   * via an effect on scroll / pageBase / watchAddr; the section
   * header's recall button reads it to gate its render.
   */
  readonly memWatchOnView: Accessor<boolean>;
  setMemWatchOnView(visible: boolean): void;
  readonly ioWatchOnView: Accessor<boolean>;
  setIoWatchOnView(visible: boolean): void;
  readonly ioWatchOnViewWrite: Accessor<boolean>;
  setIoWatchOnViewWrite(visible: boolean): void;

  /**
   * Page size — one of `PAGE_SIZE_OPTIONS`. Persisted via section
   * config. Drives the per-section page-navigation model: body
   * renders one page at a time, page-nav buttons step by `pageSize`.
   */
  readonly memPageSize: Accessor<number>;
  setMemPageSize(n: number): void;
  readonly ioPageSize: Accessor<number>;
  setIoPageSize(n: number): void;

  /**
   * Bytes-per-row for each hex grid. Persisted via
   * `SectionUiState.config.bytesPerRow`. Setters validate against the
   * grid's allowed set — `MEMORY_BYTES_PER_ROW_OPTIONS` (16…128) for
   * memory, `IO_BYTES_PER_ROW_OPTIONS` (16…64) for IO, which caps lower
   * because the 8-bit view would otherwise render duplicate rows. An
   * invalid value throws `RangeError`.
   */
  readonly memBytesPerRow: Accessor<number>;
  setMemBytesPerRow(n: number): void;
  readonly memShowBytes: Accessor<boolean>;
  setMemShowBytes(v: boolean): void;
  readonly memShowAscii: Accessor<boolean>;
  setMemShowAscii(v: boolean): void;
  readonly ioBytesPerRow: Accessor<number>;
  setIoBytesPerRow(n: number): void;

  /**
   * IO render mode. '16bit' (default) shows the 64K-port
   * grid; '8bit' shows a fixed 256-cell low-byte-decoded view whose
   * edits broadcast through `setIoBytePort8`. Persisted via the IO
   * section's config; malformed values fall back to '16bit'.
   */
  readonly ioViewMode: Accessor<"16bit" | "8bit">;
  setIoViewMode(mode: "16bit" | "8bit"): void;

  /**
   * Reload-required settings. Each is baked into bus
   * construction (`splitIo`/`memInit`/`ioInit` decide allocation and
   * fill bytes), so changes only land on a fresh page boot. Each lives
   * in its natural-owner section's config (`io` for the IO pair,
   * `memory` for `memInit`); the live accessors fall back to the bus's
   * runtime authority when nothing is persisted or the persisted value
   * is malformed.
   *
   * App-shell pending values stage the next-boot values. The App-shell
   * body's inputs bind to these, NOT the live accessors. Save calls
   * `commitReloadSettings` (single atomic persist + reload across all
   * three); Discard resets each pending back to its live value.
   * `reloadSettingsDirty()` is the OR of the three per-setting dirty
   * flags and drives the section's fold-lock + Save/Discard visibility.
   * `commitReloadSettings` is paused-only.
   */
  readonly splitIo: Accessor<boolean>;
  readonly pendingSplitIo: Accessor<boolean>;
  setPendingSplitIo(on: boolean): void;
  readonly splitIoDirty: Accessor<boolean>;

  readonly memInit: Accessor<number>;
  readonly pendingMemInit: Accessor<number>;
  setPendingMemInit(byte: number): void;
  readonly memInitDirty: Accessor<boolean>;

  readonly ioInit: Accessor<number>;
  readonly pendingIoInit: Accessor<number>;
  setPendingIoInit(byte: number): void;
  readonly ioInitDirty: Accessor<boolean>;

  readonly reloadSettingsDirty: Accessor<boolean>;
  commitReloadSettings(): void;

  // ── input pins. The HW-trace per-row checkboxes call
  // `setInputPin`; the Interrupts section calls `setIntVector`.
  readonly inputPins: SolidStore<InputPinsState>;
  /**
   * Set a CPU input pin level. Writes through to the bus (authoritative)
   * and updates the reactive mirror so UI re-renders. Value is masked to
   * 0|1 at the boundary. Paused-only — calls during run no-op, matching
   * the bus-write convention shared with `setMemByte`/`setIoByte`. nNMI
   * is a level pin from the UI's perspective, but boot.tsx auto-clears
   * it after one HC so it reads as a 1-HC pulse in the HW trace
   * ([[feedback-nmi-pulse-semantics]]).
   */
  setInputPin(name: InputPinName, value: 0 | 1): void;
  setIntVector(byte: number): void;
  /**
   * Reactive mirror of the bus's INT generator config. Re-syncs from
   * the bus on every `loop.onTick` so the UI sees the live generator
   * state without per-edge Solid signal writes. Paused-only writes
   * go through `setIntGen`.
   */
  readonly intGen: Accessor<IntGenConfig>;
  /**
   * Update the INT generator config. Paused-only — no-ops while running.
   * Writes through `bus.setIntGen` (which enforces invariants and applies
   * state transitions) then reads the bus back for the reactive mirror.
   * Persists via `updateSectionConfig('interrupts', ...)`.
   * While the generator is enabled, `setInputPin('nINT', ...)` is a no-op
   * (the generator owns the pin).
   */
  setIntGen(partial: Partial<IntGenConfig>): void;

  // ── program files
  readonly files: SolidStore<ProgramFile[]>;
  readonly fileSessions: SolidStore<Record<string, ProgramFileSession>>;
  addFile(input: NewProgramFile): void;
  removeFile(id: string): void;
  setFileLoadAddr(id: string, addr: number): void;
  setFileAutoload(id: string, on: boolean): void;
  reorderFiles(orderedIds: string[]): void;
  /** Writes one file at its current loadAddr ("load" button). */
  writeFileToMemory(id: string): void;
  /** Writes autoload-flagged files; used at boot. */
  loadAutoloadFiles(): void;
  /** Writes every file at its loadAddr ("reload all"). */
  reloadAllFiles(): void;

  // ── breakpoints. Each mutation calls
  // loop.setBreakpoints with the current full list and persists via
  // the backend (fire-and-forget — store updates synchronously).
  readonly breakpoints: SolidStore<Breakpoint[]>;
  addBreakpoint(b: NewBreakpoint): void;
  removeBreakpoint(id: string): void;
  toggleBreakpoint(id: string): void;
  editBreakpoint(id: string, patch: BreakpointPatch): void;

  /**
   * Active theme — "light" | "dark" | "system" (REQ §7.6). System
   * mode follows `prefers-color-scheme` live; the segmented control in
   * the app header writes this via `setTheme`. Persisted via the
   * storage backend (UiState.theme); invalid persisted values collapse
   * to "system" at boot.
   */
  readonly theme: Accessor<Theme>;
  setTheme(t: Theme): void;

  /**
   * UI throttle cadence. Defaults to `DEFAULT_UI_CONFIG`
   * (30 Hz). Live-editable via `setUiConfig` and persisted through
   * the storage backend so a reload restores the user's choice.
   */
  readonly uiConfig: Accessor<UiConfig>;
  /**
   * Merge a partial UI config into the current value. Validates each
   * field at the boundary — `flushEveryNFrames` must be an integer ≥ 1.
   * Persists via the storage backend (commit-on-end; one write per call).
   */
  setUiConfig(patch: Partial<UiConfig>): void;

  /**
   * Tear-down for store-owned timers. Blocks the throttle's pending
   * `requestAnimationFrame` callback from firing a signal write after
   * the consuming component tree is gone. Called from `bootApp().dispose`
   * and from tests that hot-swap the global rAF scheduler.
   */
  dispose(): void;
}
