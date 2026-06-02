import type { CpuState } from "@dcorp80/z80cpu";
import type { Accessor } from "solid-js";
import type { Store as SolidStore } from "solid-js/store";
import type { UiConfig } from "../config/defaults.ts";
import type { BusAccessRecord } from "../runloop/bus.ts";
import type { PauseReason, RunStatus } from "../runloop/loop.ts";
import type {
  Breakpoint,
  ProgramFile,
  ProgramFileSession,
  SectionUiState,
} from "../storage/types.ts";
import type { TraceRing } from "./traceRing.ts";

export type { UiConfig } from "../config/defaults.ts";

export type { BusAccessRecord } from "../runloop/bus.ts";
// Re-export so loop / sections can import BP-related types from a single
// hub (the store) without reaching into storage internals.
export type { Breakpoint } from "../storage/types.ts";
export type { TraceRecord, TraceRing } from "./traceRing.ts";

/**
 * Per-section view cursor (DESIGN §3.6). `live` = follow the head of
 * the underlying buffer; `detached` = pinned at the given HC, ignoring
 * new appends until the user snaps back to live.
 */
export type ViewCursor =
  | { mode: "live" }
  | { mode: "detached"; anchorHc: number };

/**
 * Cursor slice — one entry per traced section. M6 instantiates only
 * `instructionTrace`; the `hwTrace` key arrives with M8.
 */
export interface CursorsState {
  instructionTrace: ViewCursor;
}

export interface InputPinsState {
  /** Byte placed on `cpu.bus.data` during INT-acknowledge cycles (REQ §6.4). */
  intVector: number;
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
  readonly hc: Accessor<number>;
  readonly insnCount: Accessor<number>;
  /**
   * rAF-coalesced mirror of `insnCount` for UI consumers. While
   * running, the raw `insnCount` ticks per instruction (~10⁵–10⁶
   * Hz at full speed); section render paths read this instead so
   * the BP status line and the trace folded summary don't repaint
   * the DOM hundreds of thousands of times per second. Flushed
   * synchronously on pause (including step-pauses) and on zeroHC,
   * matching `traceRingVersionThrottled`.
   */
  readonly insnCountThrottled: Accessor<number>;
  readonly lastPauseReason: Accessor<PauseReason | null>;

  // ── CPU state (REQ §6.5). Sampled on every pause; the boundary flag
  // is true only when the pause landed exactly on M1_T3_1 (then the
  // register file is fully valid and the section paints diff highlights;
  // otherwise it dims to signal "transitional state").
  readonly cpuState: Accessor<CpuState>;
  readonly prevCpuStateAtBoundary: Accessor<CpuState>;
  readonly atInstructionBoundary: Accessor<boolean>;

  run(): void;
  pause(): void;
  stepInstructions(n: number): void;
  stepHC(n: number): void;
  zeroHC(): void;

  // ── instruction trace (DESIGN §3.1). Ring is the canonical buffer;
  // `traceRingVersion` bumps on push/clear so sections re-render via a
  // memo keyed on the version rather than tracking each record.
  // `traceRingVersionThrottled` is rAF-debounced during run and
  // flushed immediately on pause-edge (REQ §7.5: trace panes batch
  // appends while running, flush on the next paint). When the loop is
  // already paused, the throttle is bypassed so step-pause and tests
  // observe updates synchronously.
  readonly traceRing: TraceRing;
  readonly traceRingVersion: Accessor<number>;
  readonly traceRingVersionThrottled: Accessor<number>;

  // ── view cursors (DESIGN §3.6, REQ §7.2). Default `live`; detached
  // by scroll-back; snap-to-live button (and `g` hotkey) reattaches.
  readonly cursors: SolidStore<CursorsState>;
  detachInstructionTraceCursor(anchorHc: number): void;
  snapInstructionTraceCursorToLive(): void;

  // ── memory & IO read/write (REQ §6.6 / §6.7). Sections read through
  // `memByte` / `ioByte`; the createMemo tracking the matching version
  // signal re-runs after writes. `setMemByte` / `setIoByte` are
  // paused-only — calls during run no-op (REQ §7.5).
  memByte(addr: number): number;
  readonly memVersion: Accessor<number>;
  setMemByte(addr: number, value: number): void;
  ioByte(addr: number): number;
  readonly ioVersion: Accessor<number>;
  setIoByte(addr: number, value: number): void;
  /**
   * 8-bit-decoded IO write (REQ §11). Writes `value` to all 256
   * high-byte aliases of `port` in `bus.io` so subsequent CPU reads
   * return the same value regardless of the upper address byte.
   * `port` is 0..0xFF; out-of-range throws `RangeError`. Paused-only;
   * calls during run no-op (same gate as `setIoByte`).
   */
  setIoBytePort8(port: number, value: number): void;

  // ── bus last-touched (REQ §6.6 / §6.7 folded summaries). Sampled
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
   * Bytes-per-row for each hex grid (16 / 32 / 64). Persisted via
   * `SectionUiState.config.bytesPerRow`. Setters validate against
   * `BYTES_PER_ROW_OPTIONS`; an invalid value throws `RangeError`.
   */
  readonly memBytesPerRow: Accessor<number>;
  setMemBytesPerRow(n: number): void;
  readonly ioBytesPerRow: Accessor<number>;
  setIoBytesPerRow(n: number): void;

  /**
   * IO render mode (REQ §11). '16bit' (default) shows the 64K-port
   * grid; '8bit' shows a fixed 256-cell low-byte-decoded view whose
   * edits broadcast through `setIoBytePort8`. Persisted via the IO
   * section's config; malformed values fall back to '16bit'.
   */
  readonly ioViewMode: Accessor<"16bit" | "8bit">;
  setIoViewMode(mode: "16bit" | "8bit"): void;

  // ── input pins
  readonly inputPins: SolidStore<InputPinsState>;
  setIntVector(byte: number): void;

  // ── program files (REQ §6.1)
  readonly files: SolidStore<ProgramFile[]>;
  readonly fileSessions: SolidStore<Record<string, ProgramFileSession>>;
  addFile(input: NewProgramFile): void;
  removeFile(id: string): void;
  setFileLoadAddr(id: string, addr: number): void;
  setFileAutoload(id: string, on: boolean): void;
  reorderFiles(orderedIds: string[]): void;
  /** Writes one file at its current loadAddr (REQ §6.1 "load" button). */
  writeFileToMemory(id: string): void;
  /** Writes autoload-flagged files; used at boot. */
  loadAutoloadFiles(): void;
  /** Writes every file at its loadAddr (REQ §6.1 "reload all"). */
  reloadAllFiles(): void;

  // ── breakpoints (REQ §6.2; DESIGN §3.5). Each mutation calls
  // loop.setBreakpoints with the current full list and persists via
  // the backend (fire-and-forget — store updates synchronously).
  readonly breakpoints: SolidStore<Breakpoint[]>;
  addBreakpoint(b: NewBreakpoint): void;
  removeBreakpoint(id: string): void;
  toggleBreakpoint(id: string): void;
  editBreakpoint(id: string, patch: BreakpointPatch): void;

  /**
   * UI throttle cadence (REQ §7.5). Defaults to `DEFAULT_UI_CONFIG`
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
