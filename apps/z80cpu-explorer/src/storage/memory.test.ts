import { describe, expect, it } from "vitest";
import { MemoryBackend } from "./memory.ts";

describe("MemoryBackend", () => {
  it("returns null when no ui state saved", async () => {
    const b = new MemoryBackend();
    expect(await b.loadUiState()).toBeNull();
  });

  it("round-trips ui state by value", async () => {
    const b = new MemoryBackend();
    const state = {
      sections: [
        { id: "program", folded: false, config: {} },
        { id: "memory", folded: true, config: { jumpAddr: 0x8000 } },
      ],
    };
    await b.saveUiState(state);
    const loaded = await b.loadUiState();
    expect(loaded).toEqual(state);
    // Mutating the returned value must not leak back into storage.
    loaded.sections[0].folded = true;
    const again = await b.loadUiState();
    expect(again?.sections[0].folded).toBe(false);
  });

  it("round-trips files including byte copies", async () => {
    const b = new MemoryBackend();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await b.putFile({
      id: "f1",
      name: "rom.bin",
      bytes,
      loadAddr: 0,
      autoload: true,
    });
    bytes[0] = 99; // outside mutation must not leak in
    const [stored] = await b.listFiles();
    expect(Array.from(stored.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("deletes files", async () => {
    const b = new MemoryBackend();
    await b.putFile({
      id: "f1",
      name: "a",
      bytes: new Uint8Array(0),
      loadAddr: 0,
      autoload: false,
    });
    await b.deleteFile("f1");
    expect(await b.listFiles()).toHaveLength(0);
  });

  it("round-trips breakpoints", async () => {
    const b = new MemoryBackend();
    const bps = [
      {
        id: "bp1",
        kind: "pc-range" as const,
        lo: 0,
        hi: 0xff,
        enabled: true,
      },
    ];
    await b.saveBreakpoints(bps);
    expect(await b.loadBreakpoints()).toEqual(bps);
  });
});
