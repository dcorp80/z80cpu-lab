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

// Re-export so loop / sections can import BP-related types from a single
// hub (the store) without reaching into storage internals.
export type { Breakpoint } from "../storage/types.ts";

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
}
