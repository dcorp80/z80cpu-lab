import type {
  Breakpoint,
  ProgramFile,
  StorageBackend,
  UiState,
} from "./types.ts";

// In-memory StorageBackend. Default for tests and the milestone-1 boot path;
// IndexedDB takes over in milestone 10.

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
