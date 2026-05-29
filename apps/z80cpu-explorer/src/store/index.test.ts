import { describe, expect, it } from "vitest";
import { defaultSectionIds } from "../sections/sectionRegistry.ts";
import { MemoryBackend } from "../storage/memory.ts";
import { createAppStore } from "./index.ts";
import { makeStubLoop } from "./testStubLoop.ts";

function makeStubBus() {
  let v = 0xff;
  return {
    intVector: () => v,
    setIntVector: (b: number) => {
      v = b & 0xff;
    },
  };
}

async function freshStore() {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const store = await createAppStore({ backend, loop, bus });
  return { backend, store, loop, bus };
}

// Persistence is fire-and-forget; await a microtask to let saveUiState settle.
const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("createAppStore", () => {
  it("seeds the shipped default section order when storage is empty", async () => {
    const { store } = await freshStore();
    expect(store.sections.map((s) => s.id)).toEqual(defaultSectionIds());
    expect(store.sections.every((s) => !s.folded)).toBe(true);
  });

  it("restores stored section order and fold state", async () => {
    const backend = new MemoryBackend();
    await backend.saveUiState({
      sections: [
        { id: "memory", folded: true, config: { jumpAddr: 0x8000 } },
        { id: "program", folded: false, config: {} },
      ],
    });
    const store = await createAppStore({
      backend,
      loop: makeStubLoop(),
      bus: makeStubBus(),
    });
    // Stored ids come first in their stored order; remaining registry ids
    // fill in afterward with defaults.
    expect(store.sections[0]).toEqual({
      id: "memory",
      folded: true,
      config: { jumpAddr: 0x8000 },
    });
    expect(store.sections[1].id).toBe("program");
    expect(store.sections.length).toBe(defaultSectionIds().length);
    // Unknown ids in storage are dropped silently.
    const ids = store.sections.map((s) => s.id);
    for (const id of ids) expect(defaultSectionIds()).toContain(id);
  });

  it("toggles fold state and persists", async () => {
    const { backend, store } = await freshStore();
    store.toggleSectionFold("memory");
    await flush();
    expect(store.sections.find((s) => s.id === "memory")?.folded).toBe(true);
    const saved = await backend.loadUiState();
    expect(saved?.sections.find((s) => s.id === "memory")?.folded).toBe(true);
    store.toggleSectionFold("memory");
    await flush();
    expect(store.sections.find((s) => s.id === "memory")?.folded).toBe(false);
  });

  it("ignores fold toggle for unknown id", async () => {
    const { store } = await freshStore();
    const before = store.sections.map((s) => s.folded);
    store.toggleSectionFold("nope");
    expect(store.sections.map((s) => s.folded)).toEqual(before);
  });

  it("reorders sections by id list and persists", async () => {
    const { backend, store } = await freshStore();
    const reversed = [...defaultSectionIds()].reverse();
    store.reorderSections(reversed);
    await flush();
    expect(store.sections.map((s) => s.id)).toEqual(reversed);
    const saved = await backend.loadUiState();
    expect(saved?.sections.map((s) => s.id)).toEqual(reversed);
  });

  it("reorder preserves per-section state across the move", async () => {
    const { store } = await freshStore();
    store.toggleSectionFold("hwTrace");
    store.updateSectionConfig("hwTrace", { mode: "ring" });
    const moved = [
      "hwTrace",
      ...defaultSectionIds().filter((id) => id !== "hwTrace"),
    ];
    store.reorderSections(moved);
    expect(store.sections[0]).toEqual({
      id: "hwTrace",
      folded: true,
      config: { mode: "ring" },
    });
  });

  it("reorder appends any ids missing from the input list at the end", async () => {
    const { store } = await freshStore();
    // Only name one id explicitly; the others should follow in original order.
    store.reorderSections(["hwTrace"]);
    const ids = store.sections.map((s) => s.id);
    expect(ids[0]).toBe("hwTrace");
    expect(new Set(ids)).toEqual(new Set(defaultSectionIds()));
  });

  it("updateSectionConfig merges and persists", async () => {
    const { backend, store } = await freshStore();
    store.updateSectionConfig("program", { activeFile: "f1" });
    store.updateSectionConfig("program", { jumpAddr: 0x8000 });
    await flush();
    expect(store.sections.find((s) => s.id === "program")?.config).toEqual({
      activeFile: "f1",
      jumpAddr: 0x8000,
    });
    const saved = await backend.loadUiState();
    expect(saved?.sections.find((s) => s.id === "program")?.config).toEqual({
      activeFile: "f1",
      jumpAddr: 0x8000,
    });
  });

  describe("run/pause/step actions", () => {
    it("run() forwards to loop and updates status signal", async () => {
      const { store, loop } = await freshStore();
      store.run();
      expect(loop.lastCmd).toBe("run");
      expect(store.status()).toBe("running");
    });

    it("pause() forwards to loop; status follows loop.onPause", async () => {
      const { store, loop } = await freshStore();
      store.run();
      store.pause();
      expect(loop.lastCmd).toBe("pause");
      expect(store.status()).toBe("paused");
      expect(store.lastPauseReason()).toEqual({ kind: "user" });
    });

    it("stepInstructions(N) forwards and marks stepping", async () => {
      const { store, loop } = await freshStore();
      store.stepInstructions(5);
      expect(loop.lastCmd).toBe("stepInstructions");
      expect(loop.lastStepN).toBe(5);
      expect(store.status()).toBe("stepping");
    });

    it("stepInstructions ignores zero/negative", async () => {
      const { store, loop } = await freshStore();
      store.stepInstructions(0);
      expect(loop.lastCmd).toBe(null);
      store.stepInstructions(-1);
      expect(loop.lastCmd).toBe(null);
    });

    it("hc accessor follows loop tick events", async () => {
      const { store, loop } = await freshStore();
      loop.emitTick(42);
      expect(store.hc()).toBe(42);
    });

    it("insnCount accessor follows loop instruction events", async () => {
      const { store, loop } = await freshStore();
      loop.emitInstruction({} as never);
      loop.emitInstruction({} as never);
      expect(store.insnCount()).toBe(2);
    });

    it("zeroHC zeros the displayed hc and instruction count", async () => {
      const { store, loop } = await freshStore();
      loop.emitTick(100);
      loop.emitInstruction({} as never);
      expect(store.hc()).toBe(100);
      expect(store.insnCount()).toBe(1);
      store.zeroHC();
      expect(loop.lastCmd).toBe("zeroHC");
      expect(store.hc()).toBe(0);
      expect(store.insnCount()).toBe(0);
    });

    it("setIntVector masks to 8 bits and pushes through to the bus", async () => {
      const { store, bus } = await freshStore();
      store.setIntVector(0x1ab);
      expect(store.inputPins.intVector).toBe(0xab);
      expect(bus.intVector()).toBe(0xab);
    });

    it("run() clears the previous pause reason", async () => {
      const { store, loop } = await freshStore();
      store.run();
      store.pause();
      expect(store.lastPauseReason()).toEqual({ kind: "user" });
      store.run();
      expect(store.lastPauseReason()).toBeNull();
      // And the next pause's reason takes over.
      loop.emitPause({ kind: "step-complete" });
      expect(store.lastPauseReason()).toEqual({ kind: "step-complete" });
    });

    it("stepInstructions / stepHC clear the previous pause reason", async () => {
      const { store } = await freshStore();
      store.run();
      store.pause();
      expect(store.lastPauseReason()).toEqual({ kind: "user" });
      store.stepInstructions(2);
      expect(store.lastPauseReason()).toBeNull();
      store.pause();
      store.stepHC(2);
      expect(store.lastPauseReason()).toBeNull();
    });
  });
});
