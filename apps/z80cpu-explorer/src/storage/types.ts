// Pluggable storage backend. The UI-state surface is wired first; file
// and breakpoint methods are defined here so backends implement them once
// and stay stable as more sections come online.

import type { UiConfig } from "../config/defaults.ts";

export interface SectionUiState {
  id: string;
  folded: boolean;
  config: Record<string, unknown>;
}

export interface UiState {
  /** Ordered list of section ids, top → bottom. */
  sections: SectionUiState[];
  /**
   * Ordered list of file ids. File records themselves live in the
   * file table; order is UI state and travels here. Unknown ids are
   * dropped, missing ids are appended on load (same reconciliation
   * pattern as `sections`).
   */
  fileOrder?: string[];
  /** Theme selector; `null` falls back to 'system'. Wired in milestone 11. */
  theme?: "light" | "dark" | "system" | null;
  /**
   * UI throttle cadence — falls back to `DEFAULT_UI_CONFIG` when
   * absent or malformed (older backends, missing field on first run).
   */
  uiConfig?: UiConfig;
}

/**
 * Per-file storage cap. Enforced at two layers:
 *   1. `defaultPickFile` truncates oversized picks on read (and warns), so
 *      the rest of the app only ever sees ≤cap bytes from the picker path.
 *   2. `store.addFile` rejects with `RangeError` — defense against
 *      programmatic callers (tests, future scripting) that bypass the picker.
 * Memory-write truncation (past 0xFFFF) is a separate concern handled in
 * `writeBytesToMem`.
 */
export const MAX_FILE_BYTES = 128 * 1024;

export interface ProgramFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  loadAddr: number;
  autoload: boolean;
}

/**
 * Session-only sibling of `ProgramFile`. Lives in the
 * store, never round-trips through the backend — recomputed from boot
 * (autoload writes set `lastLoadedAddr`; manual loads update it).
 * `dirty` is derived: `loadAddr !== lastLoadedAddr && lastLoadedAddr !== null`.
 */
export interface ProgramFileSession {
  lastLoadedAddr: number | null;
}

/**
 * Two breakpoint kinds in MVP. Memory / IO /
 * flag-conditional kinds are post-MVP. `id` is store-assigned; UI never
 * sees a BP without one. Lives here (storage/types) because BPs
 * round-trip through the backend; re-exported from store/types for
 * loop and section consumers.
 *
 * - `pc-range`: fires when an M1 entry (regular, NMI, or INT) lands at
 *   `lo <= cpu.regs.pc <= hi` (inclusive both ends; `lo === hi` is the
 *   single-address case).
 * - `hc-count`: fires once when the global HC counter first reaches
 *   `target` from below. Inserting a target ≤ current HC fires on the
 *   next edge; refire requires zeroHC or disable+re-enable.
 */
export type Breakpoint =
  | { id: string; kind: "pc-range"; lo: number; hi: number; enabled: boolean }
  | { id: string; kind: "hc-count"; target: number; enabled: boolean };

export interface StorageBackend {
  loadUiState(): Promise<UiState | null>;
  saveUiState(state: UiState): Promise<void>;

  listFiles(): Promise<ProgramFile[]>;
  putFile(f: ProgramFile): Promise<void>;
  deleteFile(id: string): Promise<void>;

  loadBreakpoints(): Promise<Breakpoint[]>;
  saveBreakpoints(b: Breakpoint[]): Promise<void>;
}
