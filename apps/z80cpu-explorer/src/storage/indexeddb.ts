// IndexedDB StorageBackend (REQUIREMENTS §6.1, DESIGN §5). The default
// at boot; falls back to MemoryBackend when IDB is unavailable (private
// mode, security policy, ancient browser) via `openDefaultBackend`.

import { MemoryBackend } from "./memory.ts";
import type {
  Breakpoint,
  ProgramFile,
  StorageBackend,
  UiState,
} from "./types.ts";

// Lock these forever. Renaming the DB or a store = abandoning every
// user's existing data on disk. New stores get added in a fresh
// migration block under a bumped DB_VERSION; renames are done in the
// migration too (createObjectStore new, copy records, deleteObjectStore
// old) — they're never silent.
const DB_NAME = "z80cpu-explorer";
export const DB_VERSION = 1;

const STORE_UI = "ui";
const STORE_FILES = "files";
const STORE_BPS = "breakpoints";
const STORE_META = "meta";

// Singleton primary keys. The `ui` and `breakpoints` stores hold one
// record each; `files` is keyed by `ProgramFile.id` directly.
const UI_KEY = "state";
const BPS_KEY = "all";
const META_SCHEMA_KEY = "schemaVersion";

// Stale-data policy: stores we deprecate are deleted in the migration
// for the version that deprecates them. Stale *records within a current
// store* (e.g. a section id the registry no longer knows about) are
// dropped by the loader-side reconcilers (sectionRegistry's
// `reconcileSections`, the breakpoint kind switch) — UI-state validators
// double as cleanup.
function migrate(db: IDBDatabase, oldVersion: number): void {
  // Each block runs once per user when they first open this DB_VERSION.
  // Order matters — newer blocks may reference stores created earlier.
  if (oldVersion < 1) {
    db.createObjectStore(STORE_UI, { keyPath: "id" });
    db.createObjectStore(STORE_FILES, { keyPath: "id" });
    db.createObjectStore(STORE_BPS, { keyPath: "id" });
    db.createObjectStore(STORE_META, { keyPath: "key" });
  }
  // if (oldVersion < 2) { …v1→v2 migration… }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      // `oldVersion` lives on the event, not the request — during
      // upgrade `req.result.version` is already the new version.
      migrate(req.result, (ev as IDBVersionChangeEvent).oldVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error("IndexedDB open blocked by another tab"));
  });
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txCommit(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export class IndexedDbBackend implements StorageBackend {
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<IndexedDbBackend> {
    const db = await openDb();
    const backend = new IndexedDbBackend(db);
    // Stamp the schema version on every successful open. db.version is
    // also authoritative, but writing it to `meta` gives migrations
    // (and future debug tools) a stable place to read provenance from.
    await backend.putMeta(META_SCHEMA_KEY, DB_VERSION);
    return backend;
  }

  private putMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put({ key, value });
    return txCommit(tx);
  }

  async loadUiState(): Promise<UiState | null> {
    const tx = this.db.transaction(STORE_UI, "readonly");
    const rec = await reqPromise(tx.objectStore(STORE_UI).get(UI_KEY));
    await txCommit(tx);
    if (!rec || typeof rec !== "object") return null;
    const { id: _id, ...rest } = rec as { id: string } & UiState;
    return rest as UiState;
  }

  async saveUiState(state: UiState): Promise<void> {
    const tx = this.db.transaction(STORE_UI, "readwrite");
    tx.objectStore(STORE_UI).put({ id: UI_KEY, ...state });
    return txCommit(tx);
  }

  async listFiles(): Promise<ProgramFile[]> {
    const tx = this.db.transaction(STORE_FILES, "readonly");
    const recs = await reqPromise(
      tx.objectStore(STORE_FILES).getAll() as IDBRequest<ProgramFile[]>,
    );
    await txCommit(tx);
    return recs;
  }

  async putFile(f: ProgramFile): Promise<void> {
    // Open the transaction synchronously so the IDB engine's per-store
    // `readwrite` queue serializes a put/delete pair issued from rapid
    // store actions (DESIGN §5 "Persist order"). Anything that awaits
    // before opening the tx would forfeit that ordering guarantee.
    const tx = this.db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).put(f);
    return txCommit(tx);
  }

  async deleteFile(id: string): Promise<void> {
    const tx = this.db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).delete(id);
    return txCommit(tx);
  }

  async loadBreakpoints(): Promise<Breakpoint[]> {
    const tx = this.db.transaction(STORE_BPS, "readonly");
    const rec = await reqPromise(tx.objectStore(STORE_BPS).get(BPS_KEY));
    await txCommit(tx);
    if (!rec || typeof rec !== "object") return [];
    const list = (rec as { list?: unknown }).list;
    return Array.isArray(list) ? (list as Breakpoint[]) : [];
  }

  async saveBreakpoints(b: Breakpoint[]): Promise<void> {
    const tx = this.db.transaction(STORE_BPS, "readwrite");
    tx.objectStore(STORE_BPS).put({ id: BPS_KEY, list: b });
    return txCommit(tx);
  }

  /**
   * Release the underlying DB connection. Boot-path users never need
   * to call this — the page lifetime owns the connection — but tests
   * and any in-process re-open path (e.g. switching backends) do, since
   * `indexedDB.deleteDatabase` blocks until all connections close.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Boot helper. Tries IndexedDB; on platform unavailability (private
 * mode, disabled, security policy) falls back to MemoryBackend so the
 * app still runs — only loses reload persistence. Logged to console
 * so devs can spot the fallback without surfacing a banner that 99% of
 * users would never need.
 */
export async function openDefaultBackend(): Promise<StorageBackend> {
  if (typeof indexedDB === "undefined") {
    console.warn(
      "[z80cpu-explorer] IndexedDB unavailable — running with in-memory storage; state will not survive a reload.",
    );
    return new MemoryBackend();
  }
  try {
    return await IndexedDbBackend.open();
  } catch (err) {
    console.warn(
      "[z80cpu-explorer] IndexedDB open failed — falling back to in-memory storage; state will not survive a reload.",
      err,
    );
    return new MemoryBackend();
  }
}
