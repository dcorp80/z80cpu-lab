import type { CpuState } from "@dcorp80/z80cpu";
import type { Accessor } from "solid-js";
import type { Store as SolidStore } from "solid-js/store";
import type { PauseReason, RunStatus } from "../runloop/loop.ts";
import type {
  Breakpoint,
  ProgramFile,
  ProgramFileSession,
  SectionUiState,
} from "../storage/types.ts";
import type { TraceRing } from "./traceRing.ts";

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

  // ── memory read path. Sections (instruction trace preview here, the
  // hex grid in M7) read mem through `memByte`; the createMemo tracking
  // `memVersion()` triggers re-render after writes. Editable writes
  // arrive in M7 via `setMemByte`.
  memByte(addr: number): number;
  readonly memVersion: Accessor<number>;

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
   * Tear-down for store-owned timers. Blocks the throttle's pending
   * `requestAnimationFrame` callback from firing a signal write after
   * the consuming component tree is gone. Called from `bootApp().dispose`
   * and from tests that hot-swap the global rAF scheduler.
   */
  dispose(): void;
}
