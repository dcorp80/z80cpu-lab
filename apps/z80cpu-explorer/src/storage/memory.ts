import type {
  Breakpoint,
  ProgramFile,
  StorageBackend,
  UiState,
} from "./types.ts";

// In-memory StorageBackend. Used by tests directly and as the boot
// fallback when IndexedDB is unavailable (see `openDefaultBackend` in
// `./indexeddb.ts`). State lives only for the lifetime of the instance.

export class MemoryBackend implements StorageBackend {
  private ui: UiState | null = null;
  private files = new Map<string, ProgramFile>();
  private breakpoints: Breakpoint[] = [];

  async loadUiState(): Promise<UiState | null> {
    return this.ui ? structuredClone(this.ui) : null;
  }

  async saveUiState(state: UiState): Promise<void> {
    this.ui = structuredClone(state);
  }

  async listFiles(): Promise<ProgramFile[]> {
    return Array.from(this.files.values(), (f) => ({
      ...f,
      bytes: new Uint8Array(f.bytes),
    }));
  }

  async putFile(f: ProgramFile): Promise<void> {
    this.files.set(f.id, { ...f, bytes: new Uint8Array(f.bytes) });
  }

  async deleteFile(id: string): Promise<void> {
    this.files.delete(id);
  }

  async loadBreakpoints(): Promise<Breakpoint[]> {
    return structuredClone(this.breakpoints);
  }

  async saveBreakpoints(b: Breakpoint[]): Promise<void> {
    this.breakpoints = structuredClone(b);
  }
}
