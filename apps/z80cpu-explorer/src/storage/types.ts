// Pluggable storage backend per REQUIREMENTS §6.1 and DESIGN §5.
// Milestone 1 only exercises the UI-state surface; the file and breakpoint
// methods are defined here so backends can implement them once and stay
// stable across later milestones.

export interface SectionUiState {
  id: string;
  folded: boolean;
  config: Record<string, unknown>;
}

export interface UiState {
  /** Ordered list of section ids, top → bottom. */
  sections: SectionUiState[];
  /** Theme selector; `null` falls back to 'system'. Wired in milestone 11. */
  theme?: "light" | "dark" | "system" | null;
}

// Placeholders — implemented in later milestones.
export interface ProgramFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  loadAddr: number;
  autoload: boolean;
}

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
