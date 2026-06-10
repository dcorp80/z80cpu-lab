// Unit tests for the IndexedDB backend. Uses `fake-indexeddb` so the
// migration / persistence paths run in the fast happy-dom tier; a
// separate browser-tier smoke would confirm the real engine.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DB_VERSION,
  IndexedDbBackend,
  openDefaultBackend,
} from "./indexeddb.ts";
import { MemoryBackend } from "./memory.ts";
import type { Breakpoint, ProgramFile, UiState } from "./types.ts";

const DB_NAME = "z80cpu-explorer";

// Tests track every backend they open and close them all in afterEach
// before deleting the DB. `indexedDB.deleteDatabase` blocks while any
// connection is open — same as the real engine — so missing a close()
// hangs the test runner.
const openBackends = new Set<IndexedDbBackend>();

async function trackOpen(): Promise<IndexedDbBackend> {
  const b = await IndexedDbBackend.open();
  openBackends.add(b);
  return b;
}

async function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("delete blocked"));
  });
}

async function cleanupDbs(): Promise<void> {
  for (const b of openBackends) b.close();
  openBackends.clear();
  await deleteDb(DB_NAME);
}

describe("IndexedDbBackend — open / migrate", () => {
  afterEach(cleanupDbs);

  it("creates all four stores on first open (oldVersion=0)", async () => {
    const backend = await trackOpen();
    // The four-store layout: load* / save* round-trips imply existence.
    // listFiles on a fresh DB must return [] (not throw), confirming the
    // store exists; same logic for breakpoints/UI.
    expect(await backend.listFiles()).toEqual([]);
    expect(await backend.loadBreakpoints()).toEqual([]);
    expect(await backend.loadUiState()).toBeNull();
  });

  it("stamps schemaVersion in meta on every open", async () => {
    await trackOpen();
    // Reach into the raw DB to verify the meta record. Done via a fresh
    // open since we don't expose `meta` on the public interface.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("meta", "readonly");
    const rec = await new Promise<{ key: string; value: unknown } | undefined>(
      (resolve, reject) => {
        const r = tx.objectStore("meta").get("schemaVersion");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      },
    );
    expect(rec?.value).toBe(DB_VERSION);
    db.close();
  });

  it("re-opening the same DB does not re-run the v0→v1 creation block", async () => {
    const a = await trackOpen();
    await a.putFile({
      id: "keep",
      name: "k.bin",
      bytes: new Uint8Array([1, 2, 3]),
      loadAddr: 0,
      autoload: false,
    });
    // Second open must see the record from the first session.
    const b = await trackOpen();
    const files = await b.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("keep");
  });
});

describe("IndexedDbBackend — UI state round-trip", () => {
  afterEach(cleanupDbs);

  it("loadUiState returns null when nothing has been saved", async () => {
    const backend = await trackOpen();
    expect(await backend.loadUiState()).toBeNull();
  });

  it("save + load round-trips a populated UiState (drops the synthetic id)", async () => {
    const backend = await trackOpen();
    const state: UiState = {
      sections: [
        { id: "appShell", folded: false, config: {} },
        { id: "io", folded: true, config: { splitIo: true } },
      ],
      fileOrder: ["a", "b"],
      theme: "dark",
      uiConfig: { flushEveryNFrames: 2 },
    };
    await backend.saveUiState(state);
    const loaded = await backend.loadUiState();
    // The synthetic primary key (`id: "state"`) must NOT leak into the
    // returned object — it's a storage detail, not part of UiState.
    expect(loaded).toEqual(state);
    expect((loaded as unknown as { id?: string }).id).toBeUndefined();
  });

  it("saveUiState overwrites the previous record (singleton semantics)", async () => {
    const backend = await trackOpen();
    await backend.saveUiState({
      sections: [{ id: "first", folded: false, config: {} }],
    });
    await backend.saveUiState({
      sections: [{ id: "second", folded: true, config: {} }],
    });
    const loaded = await backend.loadUiState();
    expect(loaded?.sections).toEqual([
      { id: "second", folded: true, config: {} },
    ]);
  });
});

describe("IndexedDbBackend — files", () => {
  afterEach(cleanupDbs);

  const mkFile = (id: string, bytes: number[]): ProgramFile => ({
    id,
    name: `${id}.bin`,
    bytes: new Uint8Array(bytes),
    loadAddr: 0x8000,
    autoload: false,
  });

  it("putFile / listFiles round-trips bytes via structured clone", async () => {
    const backend = await trackOpen();
    await backend.putFile(mkFile("a", [1, 2, 3, 0xff]));
    const files = await backend.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("a");
    expect(Array.from(files[0].bytes)).toEqual([1, 2, 3, 0xff]);
  });

  it("deleteFile removes the record", async () => {
    const backend = await trackOpen();
    await backend.putFile(mkFile("a", [1]));
    await backend.putFile(mkFile("b", [2]));
    await backend.deleteFile("a");
    const files = await backend.listFiles();
    expect(files.map((f) => f.id).sort()).toEqual(["b"]);
  });

  it("put+delete on the same id, fire-and-forget, settle in submission order (DESIGN §5)", async () => {
    // The persist-order hazard called out in DESIGN §5. We mirror the
    // store's fire-and-forget pattern: kick off both writes synchronously
    // *without* awaiting, then await both promises. The IDB engine's
    // per-store `readwrite` queue must serialize them in submission order
    // so the record ends up DELETED — not resurrected.
    const backend = await trackOpen();
    const file = mkFile("racy", [9]);
    const p1 = backend.putFile(file);
    const p2 = backend.deleteFile("racy");
    await Promise.all([p1, p2]);
    expect(await backend.listFiles()).toEqual([]);
  });

  it("two rapid putFile calls on the same id keep the later write (last-write-wins)", async () => {
    const backend = await trackOpen();
    const p1 = backend.putFile(mkFile("x", [1]));
    const p2 = backend.putFile(mkFile("x", [2]));
    await Promise.all([p1, p2]);
    const files = await backend.listFiles();
    expect(files).toHaveLength(1);
    expect(Array.from(files[0].bytes)).toEqual([2]);
  });
});

describe("IndexedDbBackend — breakpoints", () => {
  afterEach(cleanupDbs);

  it("loadBreakpoints returns [] on a fresh DB", async () => {
    const backend = await trackOpen();
    expect(await backend.loadBreakpoints()).toEqual([]);
  });

  it("save + load round-trips a heterogeneous breakpoint list", async () => {
    const backend = await trackOpen();
    const list: Breakpoint[] = [
      { id: "1", kind: "pc-range", lo: 0x0100, hi: 0x01ff, enabled: true },
      { id: "2", kind: "hc-count", target: 1_000_000, enabled: false },
    ];
    await backend.saveBreakpoints(list);
    const loaded = await backend.loadBreakpoints();
    expect(loaded).toEqual(list);
  });
});

describe("openDefaultBackend — fallback", () => {
  let savedIDB: typeof indexedDB | undefined;

  beforeEach(() => {
    savedIDB = globalThis.indexedDB;
  });
  afterEach(async () => {
    // Restore IDB first so cleanupDbs has a working engine to delete on.
    if (savedIDB !== undefined) {
      Object.defineProperty(globalThis, "indexedDB", {
        value: savedIDB,
        configurable: true,
      });
    }
    await cleanupDbs();
  });

  it("returns a MemoryBackend when indexedDB is undefined", async () => {
    // Simulate private mode / no-IDB platform.
    Object.defineProperty(globalThis, "indexedDB", {
      value: undefined,
      configurable: true,
    });
    const backend = await openDefaultBackend();
    expect(backend).toBeInstanceOf(MemoryBackend);
  });

  it("returns an IndexedDbBackend when IDB is available", async () => {
    const backend = await openDefaultBackend();
    expect(backend).toBeInstanceOf(IndexedDbBackend);
    // Track so cleanupDbs can close it before deleteDatabase runs.
    openBackends.add(backend as IndexedDbBackend);
  });
});
