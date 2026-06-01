import { InstructionTrace } from "@dcorp80/z80cpu-debug";
import { describe, expect, it } from "vitest";
import { defaultSectionIds } from "../sections/sectionRegistry.ts";
import { MemoryBackend } from "../storage/memory.ts";
import { createAppStore } from "./index.ts";
import { makeStubBus } from "./testStubBus.ts";
import { makeStubDbg } from "./testStubDbg.ts";
import { makeStubLoop } from "./testStubLoop.ts";

// Minimal valid InstructionTrace builder. Tests that only care that an
// instruction event fired can pass {}; tests that exercise the ring
// fill the fields that matter.
function mkTrace(
  opts: Partial<{
    startAddr: number;
    bytes: number[];
    length: number;
    m1Type: InstructionTrace["m1Type"];
    hc: number;
    nextPc: number;
  }> = {},
): InstructionTrace {
  const t = new InstructionTrace();
  t.startAddr = opts.startAddr ?? 0;
  const src = opts.bytes ?? [];
  for (let i = 0; i < src.length; i++) t.bytes[i] = src[i];
  t.length = opts.length ?? src.length;
  t.m1Type = opts.m1Type ?? "normal";
  t.hc = opts.hc ?? 0;
  t.nextPc = opts.nextPc ?? 0;
  return t;
}

async function freshStore() {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const dbg = makeStubDbg();
  const store = await createAppStore({ backend, loop, bus, dbg });
  return { backend, store, loop, bus, dbg };
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
      dbg: makeStubDbg(),
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
      loop.emitInstruction(mkTrace());
      loop.emitInstruction(mkTrace());
      expect(store.insnCount()).toBe(2);
    });

    it("zeroHC zeros the displayed hc and instruction count", async () => {
      const { store, loop } = await freshStore();
      loop.emitTick(100);
      loop.emitInstruction(mkTrace());
      expect(store.hc()).toBe(100);
      expect(store.insnCount()).toBe(1);
      store.zeroHC();
      expect(loop.lastCmd).toBe("zeroHC");
      expect(store.hc()).toBe(0);
      expect(store.insnCount()).toBe(0);
    });

    it("instruction trace ring captures emitted instructions", async () => {
      const { store, loop } = await freshStore();
      const v0 = store.traceRingVersion();
      loop.setHc(50);
      loop.emitInstruction(
        mkTrace({
          startAddr: 0x100,
          bytes: [0x3e, 0x42],
          length: 2,
          hc: 8,
          nextPc: 0x102,
        }),
      );
      expect(store.traceRing.size()).toBe(1);
      const rec = store.traceRing.at(0);
      expect(rec?.startAddr).toBe(0x100);
      expect(rec?.bytes.slice(0, rec.length)).toEqual([0x3e, 0x42]);
      expect(rec?.nextPc).toBe(0x102);
      // hcAtComplete = loop.hc() at callback time.
      expect(rec?.hc).toBe(50);
      // Version bumped so consumers re-render.
      expect(store.traceRingVersion()).toBeGreaterThan(v0);
    });

    it("zeroHC clears the trace ring and bumps its version", async () => {
      const { store, loop } = await freshStore();
      loop.emitInstruction(mkTrace({ startAddr: 0x100 }));
      loop.emitInstruction(mkTrace({ startAddr: 0x101 }));
      expect(store.traceRing.size()).toBe(2);
      const vBefore = store.traceRingVersion();
      store.zeroHC();
      expect(store.traceRing.size()).toBe(0);
      expect(store.traceRingVersion()).toBeGreaterThan(vBefore);
    });

    it("instruction-trace cursor: detach + snap actions update the slice", async () => {
      const { store } = await freshStore();
      expect(store.cursors.instructionTrace).toEqual({ mode: "live" });
      store.detachInstructionTraceCursor(1234);
      expect(store.cursors.instructionTrace).toEqual({
        mode: "detached",
        anchorHc: 1234,
      });
      store.snapInstructionTraceCursorToLive();
      expect(store.cursors.instructionTrace).toEqual({ mode: "live" });
    });

    it("zeroHC snaps the instruction-trace cursor back to live", async () => {
      const { store } = await freshStore();
      store.detachInstructionTraceCursor(999);
      store.zeroHC();
      expect(store.cursors.instructionTrace).toEqual({ mode: "live" });
    });

    it("throttled trace-ring version fires synchronously when loop is paused", async () => {
      const { store, loop } = await freshStore();
      // Stub loop starts paused → throttle bypass kicks in.
      expect(loop.status()).toBe("paused");
      const v0 = store.traceRingVersionThrottled();
      loop.emitInstruction(mkTrace({ startAddr: 0x100 }));
      expect(store.traceRingVersionThrottled()).toBeGreaterThan(v0);
    });

    it("throttled version coalesces pushes during run, flushes on pause", async () => {
      // Replace rAF with a controllable scheduler so we can pin down
      // "the throttle hasn't fired yet" deterministically.
      const queued: Array<FrameRequestCallback> = [];
      const origRaf = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        queued.push(cb);
        return queued.length;
      }) as typeof requestAnimationFrame;
      try {
        const { store, loop } = await freshStore();
        // Move into running; subsequent pushes should NOT bump
        // throttled until rAF fires.
        loop.setStatus("running");
        const v0 = store.traceRingVersionThrottled();
        loop.emitInstruction(mkTrace({ startAddr: 0x100 }));
        loop.emitInstruction(mkTrace({ startAddr: 0x101 }));
        loop.emitInstruction(mkTrace({ startAddr: 0x102 }));
        // Raw version moved by 3; throttled still pinned.
        expect(store.traceRingVersion()).toBeGreaterThanOrEqual(v0 + 3);
        expect(store.traceRingVersionThrottled()).toBe(v0);
        // One rAF frame "elapses" — single throttle fire regardless of
        // how many pushes accumulated.
        expect(queued.length).toBe(1);
        queued.shift()?.(0);
        expect(store.traceRingVersionThrottled()).toBeGreaterThan(v0);
        const vAfterRaf = store.traceRingVersionThrottled();
        // Another push during run → schedules a fresh rAF.
        loop.emitInstruction(mkTrace({ startAddr: 0x103 }));
        expect(store.traceRingVersionThrottled()).toBe(vAfterRaf);
        expect(queued.length).toBe(1);
        // Pause flushes the throttle synchronously without waiting for
        // the queued rAF.
        loop.emitPause({ kind: "user" });
        expect(store.traceRingVersionThrottled()).toBeGreaterThan(vAfterRaf);
      } finally {
        globalThis.requestAnimationFrame = origRaf;
      }
    });
  });

  describe("memory read accessor (M6 read path)", () => {
    it("memByte reads from the bus mem array, masked to 16 bits", async () => {
      const { store, bus } = await freshStore();
      bus.mem[0x1234] = 0xab;
      expect(store.memByte(0x1234)).toBe(0xab);
      // Mask: 0x10005 → 0x0005
      bus.mem[0x0005] = 0xcd;
      expect(store.memByte(0x10005)).toBe(0xcd);
    });

    it("memVersion bumps on file write", async () => {
      const { store } = await freshStore();
      const v0 = store.memVersion();
      store.addFile({
        name: "rom.bin",
        bytes: new Uint8Array([0xde, 0xad]),
        loadAddr: 0x0000,
      });
      store.writeFileToMemory(store.files[0].id);
      expect(store.memVersion()).toBeGreaterThan(v0);
      expect(store.memByte(0x0000)).toBe(0xde);
      expect(store.memByte(0x0001)).toBe(0xad);
    });
  });

  describe("memory & IO write actions (M7 — REQ §6.6 / §6.7)", () => {
    it("setMemByte writes to mem and bumps memVersion when paused", async () => {
      const { store, bus } = await freshStore();
      // Stub loop starts paused — write should land.
      const v0 = store.memVersion();
      store.setMemByte(0x4020, 0xa7);
      expect(bus.mem[0x4020]).toBe(0xa7);
      expect(store.memByte(0x4020)).toBe(0xa7);
      expect(store.memVersion()).toBeGreaterThan(v0);
    });

    it("setMemByte no-ops while running (paused-only gate per §7.5)", async () => {
      const { store, bus, loop } = await freshStore();
      loop.setStatus("running");
      // Drive the reactive store.status() signal to "running" too — the
      // gate reads the store-side signal, not loop.status().
      store.run();
      const v0 = store.memVersion();
      store.setMemByte(0x4020, 0xa7);
      expect(bus.mem[0x4020]).toBe(0xff);
      expect(store.memVersion()).toBe(v0);
    });

    it("setMemByte rejects out-of-range addrs and values", async () => {
      const { store } = await freshStore();
      expect(() => store.setMemByte(-1, 0)).toThrow(RangeError);
      expect(() => store.setMemByte(0x10000, 0)).toThrow(RangeError);
      expect(() => store.setMemByte(0, -1)).toThrow(RangeError);
      expect(() => store.setMemByte(0, 0x100)).toThrow(RangeError);
      expect(() => store.setMemByte(0, 1.5)).toThrow(RangeError);
    });

    it("ioByte reads from bus.io masked to 16 bits; ioVersion bumps on setIoByte", async () => {
      const { store, bus } = await freshStore();
      bus.io[0x00fe] = 0xbf;
      expect(store.ioByte(0x00fe)).toBe(0xbf);
      // Mask: 0x100fe → 0x00fe
      expect(store.ioByte(0x100fe)).toBe(0xbf);
      const v0 = store.ioVersion();
      store.setIoByte(0x00fe, 0x07);
      expect(bus.io[0x00fe]).toBe(0x07);
      expect(store.ioByte(0x00fe)).toBe(0x07);
      expect(store.ioVersion()).toBeGreaterThan(v0);
    });

    it("setIoByte no-ops while running", async () => {
      const { store, bus, loop } = await freshStore();
      loop.setStatus("running");
      store.run();
      const v0 = store.ioVersion();
      store.setIoByte(0x00fe, 0x07);
      expect(bus.io[0x00fe]).toBe(0xff);
      expect(store.ioVersion()).toBe(v0);
    });

    it("setIoByte rejects out-of-range addrs and values", async () => {
      const { store } = await freshStore();
      expect(() => store.setIoByte(-1, 0)).toThrow(RangeError);
      expect(() => store.setIoByte(0x10000, 0)).toThrow(RangeError);
      expect(() => store.setIoByte(0, 0x100)).toThrow(RangeError);
    });
  });

  describe("bus last-touched sampling (M7)", () => {
    it("all four accessors start null on a fresh store", async () => {
      const { store } = await freshStore();
      expect(store.lastMemRead()).toBeNull();
      expect(store.lastMemWrite()).toBeNull();
      expect(store.lastIoRead()).toBeNull();
      expect(store.lastIoWrite()).toBeNull();
    });

    it("samples bus accessors on every pause-edge", async () => {
      const { store, bus, loop } = await freshStore();
      bus.setLastMemRead({ addr: 0x0042, value: 0xab });
      bus.setLastMemWrite({ addr: 0x4020, value: 0xa7 });
      bus.setLastIoRead({ addr: 0x00fe, value: 0xbf });
      bus.setLastIoWrite({ addr: 0x00fe, value: 0x07 });
      loop.emitPause({ kind: "user" });
      expect(store.lastMemRead()).toEqual({ addr: 0x0042, value: 0xab });
      expect(store.lastMemWrite()).toEqual({ addr: 0x4020, value: 0xa7 });
      expect(store.lastIoRead()).toEqual({ addr: 0x00fe, value: 0xbf });
      expect(store.lastIoWrite()).toEqual({ addr: 0x00fe, value: 0x07 });
    });

    it("a later pause overwrites the snapshot", async () => {
      const { store, bus, loop } = await freshStore();
      bus.setLastMemWrite({ addr: 0x0001, value: 0x11 });
      loop.emitPause({ kind: "user" });
      bus.setLastMemWrite({ addr: 0x0002, value: 0x22 });
      loop.emitPause({ kind: "step-complete" });
      expect(store.lastMemWrite()).toEqual({ addr: 0x0002, value: 0x22 });
    });
  });

  describe("watch addr persistence (M7)", () => {
    it("defaults to 0 when section config is empty", async () => {
      const { store } = await freshStore();
      expect(store.memWatchAddr()).toBe(0);
      expect(store.ioWatchAddr()).toBe(0);
    });

    it("setMemWatchAddr writes through to section config", async () => {
      const { store } = await freshStore();
      store.setMemWatchAddr(0x4020);
      expect(store.memWatchAddr()).toBe(0x4020);
      // Stored under the section's config map so reload restores it.
      const mem = store.sections.find((s) => s.id === "memory");
      expect(mem?.config.watchAddr).toBe(0x4020);
    });

    it("setIoWatchAddr is independent of memWatchAddr", async () => {
      const { store } = await freshStore();
      store.setMemWatchAddr(0x4020);
      store.setIoWatchAddr(0x00fe);
      expect(store.memWatchAddr()).toBe(0x4020);
      expect(store.ioWatchAddr()).toBe(0x00fe);
    });

    it("rejects out-of-range watch addresses", async () => {
      const { store } = await freshStore();
      expect(() => store.setMemWatchAddr(-1)).toThrow(RangeError);
      expect(() => store.setMemWatchAddr(0x10000)).toThrow(RangeError);
      expect(() => store.setIoWatchAddr(1.5)).toThrow(RangeError);
    });

    it("restores watch addr from stored UI state on boot", async () => {
      const backend = new MemoryBackend();
      await backend.saveUiState({
        sections: [
          { id: "memory", folded: false, config: { watchAddr: 0x8000 } },
          { id: "io", folded: false, config: { watchAddr: 0x00fe } },
        ],
      });
      const store = await createAppStore({
        backend,
        loop: makeStubLoop(),
        bus: makeStubBus(),
        dbg: makeStubDbg(),
      });
      expect(store.memWatchAddr()).toBe(0x8000);
      expect(store.ioWatchAddr()).toBe(0x00fe);
    });

    it("requestMemWatchJump bumps memWatchJumpVersion", async () => {
      const { store } = await freshStore();
      const v0 = store.memWatchJumpVersion();
      store.requestMemWatchJump();
      expect(store.memWatchJumpVersion()).toBeGreaterThan(v0);
    });

    it("requestIoWatchJump bumps ioWatchJumpVersion independently", async () => {
      const { store } = await freshStore();
      const memV = store.memWatchJumpVersion();
      const ioV = store.ioWatchJumpVersion();
      store.requestIoWatchJump();
      expect(store.ioWatchJumpVersion()).toBeGreaterThan(ioV);
      expect(store.memWatchJumpVersion()).toBe(memV);
    });
  });

  describe("bytes-per-row per section (M7)", () => {
    it("defaults to 16 for both sections", async () => {
      const { store } = await freshStore();
      expect(store.memBytesPerRow()).toBe(16);
      expect(store.ioBytesPerRow()).toBe(16);
    });

    it("setMemBytesPerRow persists via section config", async () => {
      const { store } = await freshStore();
      store.setMemBytesPerRow(32);
      expect(store.memBytesPerRow()).toBe(32);
      const mem = store.sections.find((s) => s.id === "memory");
      expect(mem?.config.bytesPerRow).toBe(32);
    });

    it("rejects non-allowed bytes-per-row values", async () => {
      const { store } = await freshStore();
      expect(() => store.setMemBytesPerRow(20)).toThrow(RangeError);
      expect(() => store.setIoBytesPerRow(8)).toThrow(RangeError);
    });

    it("restores stored bytes-per-row from UI state on boot; clamps unknowns", async () => {
      const backend = new MemoryBackend();
      await backend.saveUiState({
        sections: [
          { id: "memory", folded: false, config: { bytesPerRow: 64 } },
          // Bad value in storage — falls back to default rather than
          // breaking the grid math.
          { id: "io", folded: false, config: { bytesPerRow: 7 } },
        ],
      });
      const store = await createAppStore({
        backend,
        loop: makeStubLoop(),
        bus: makeStubBus(),
        dbg: makeStubDbg(),
      });
      expect(store.memBytesPerRow()).toBe(64);
      expect(store.ioBytesPerRow()).toBe(16);
    });
  });

  describe("legacy int-vector + pause-reason (regression block)", () => {
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

  describe("program files", () => {
    it("starts with no files when storage is empty", async () => {
      const { store } = await freshStore();
      expect(store.files.length).toBe(0);
    });

    it("addFile appends, copies bytes, persists", async () => {
      const { backend, store } = await freshStore();
      const src = new Uint8Array([1, 2, 3, 4]);
      store.addFile({ name: "rom.bin", bytes: src, loadAddr: 0x8000 });
      expect(store.files.length).toBe(1);
      const f = store.files[0];
      expect(f.name).toBe("rom.bin");
      expect(f.loadAddr).toBe(0x8000);
      expect(f.autoload).toBe(false);
      // Mutating the caller's source must not change the stored copy.
      src[0] = 0xff;
      expect(f.bytes[0]).toBe(1);
      await flush();
      const stored = await backend.listFiles();
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe("rom.bin");
    });

    it("addFile writes nothing to memory by itself", async () => {
      const { store, bus } = await freshStore();
      store.addFile({
        name: "a",
        bytes: new Uint8Array([0xaa, 0xbb]),
        loadAddr: 0,
      });
      // addFile does not load — that's the section's call (REQ §6.1).
      expect(bus.mem[0]).toBe(0xff);
      expect(bus.mem[1]).toBe(0xff);
    });

    it("writeFileToMemory copies bytes and marks the session loaded", async () => {
      const { store, bus } = await freshStore();
      store.addFile({
        name: "a",
        bytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
        loadAddr: 0x100,
      });
      const id = store.files[0].id;
      store.writeFileToMemory(id);
      expect(bus.mem[0x100]).toBe(0xaa);
      expect(bus.mem[0x101]).toBe(0xbb);
      expect(bus.mem[0x102]).toBe(0xcc);
      expect(store.fileSessions[id]?.lastLoadedAddr).toBe(0x100);
    });

    it("writeFileToMemory truncates at the end of address space", async () => {
      const { store, bus } = await freshStore();
      // 4 bytes starting at FFFE → only 2 fit (FFFE, FFFF).
      store.addFile({
        name: "tail",
        bytes: new Uint8Array([1, 2, 3, 4]),
        loadAddr: 0xfffe,
      });
      store.writeFileToMemory(store.files[0].id);
      expect(bus.mem[0xfffe]).toBe(1);
      expect(bus.mem[0xffff]).toBe(2);
    });

    it("setFileLoadAddr updates the file and persists", async () => {
      const { backend, store } = await freshStore();
      store.addFile({
        name: "a",
        bytes: new Uint8Array([0]),
        loadAddr: 0,
      });
      const id = store.files[0].id;
      store.setFileLoadAddr(id, 0x8000);
      expect(store.files[0].loadAddr).toBe(0x8000);
      await flush();
      const stored = await backend.listFiles();
      expect(stored[0].loadAddr).toBe(0x8000);
    });

    it("setFileAutoload toggles and persists", async () => {
      const { backend, store } = await freshStore();
      store.addFile({ name: "a", bytes: new Uint8Array([0]), loadAddr: 0 });
      const id = store.files[0].id;
      store.setFileAutoload(id, true);
      expect(store.files[0].autoload).toBe(true);
      await flush();
      const stored = await backend.listFiles();
      expect(stored[0].autoload).toBe(true);
    });

    it("removeFile drops the file, session, and backend record", async () => {
      const { backend, store } = await freshStore();
      store.addFile({ name: "a", bytes: new Uint8Array([0]), loadAddr: 0 });
      const id = store.files[0].id;
      store.writeFileToMemory(id);
      expect(store.fileSessions[id]).toBeDefined();
      store.removeFile(id);
      expect(store.files.length).toBe(0);
      expect(store.fileSessions[id]).toBeUndefined();
      await flush();
      expect(await backend.listFiles()).toHaveLength(0);
    });

    it("reorderFiles puts named ids first, preserves the rest", async () => {
      const { store } = await freshStore();
      store.addFile({ name: "a", bytes: new Uint8Array(), loadAddr: 0 });
      store.addFile({ name: "b", bytes: new Uint8Array(), loadAddr: 0 });
      store.addFile({ name: "c", bytes: new Uint8Array(), loadAddr: 0 });
      const ids = store.files.map((f) => f.id);
      store.reorderFiles([ids[2], ids[0]]);
      expect(store.files.map((f) => f.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    it("loadAutoloadFiles writes only autoload-flagged files", async () => {
      const { store, bus } = await freshStore();
      store.addFile({
        name: "a",
        bytes: new Uint8Array([0xaa]),
        loadAddr: 0x100,
        autoload: true,
      });
      store.addFile({
        name: "b",
        bytes: new Uint8Array([0xbb]),
        loadAddr: 0x200,
        autoload: false,
      });
      bus.mem.fill(0); // clear so we can see what's written
      store.loadAutoloadFiles();
      expect(bus.mem[0x100]).toBe(0xaa);
      expect(bus.mem[0x200]).toBe(0);
    });

    it("reloadAllFiles writes every file regardless of autoload flag", async () => {
      const { store, bus } = await freshStore();
      store.addFile({
        name: "a",
        bytes: new Uint8Array([0xaa]),
        loadAddr: 0x100,
        autoload: true,
      });
      store.addFile({
        name: "b",
        bytes: new Uint8Array([0xbb]),
        loadAddr: 0x200,
        autoload: false,
      });
      bus.mem.fill(0);
      store.reloadAllFiles();
      expect(bus.mem[0x100]).toBe(0xaa);
      expect(bus.mem[0x200]).toBe(0xbb);
    });

    it("reloadAllFiles last-write-wins for overlapping ranges", async () => {
      const { store, bus } = await freshStore();
      store.addFile({
        name: "first",
        bytes: new Uint8Array([0xaa, 0xaa]),
        loadAddr: 0x100,
      });
      store.addFile({
        name: "second",
        bytes: new Uint8Array([0xbb]),
        loadAddr: 0x100,
      });
      store.reloadAllFiles();
      // The second file lands last (display order), overwriting.
      expect(bus.mem[0x100]).toBe(0xbb);
      expect(bus.mem[0x101]).toBe(0xaa);
    });

    it("addFile and setFileLoadAddr reject out-of-range addresses", async () => {
      const { store } = await freshStore();
      expect(() =>
        store.addFile({ name: "x", bytes: new Uint8Array(), loadAddr: -1 }),
      ).toThrow(RangeError);
      expect(() =>
        store.addFile({
          name: "x",
          bytes: new Uint8Array(),
          loadAddr: 0x10000,
        }),
      ).toThrow(RangeError);
      store.addFile({ name: "ok", bytes: new Uint8Array(), loadAddr: 0 });
      const id = store.files[0].id;
      expect(() => store.setFileLoadAddr(id, -1)).toThrow(RangeError);
      expect(() => store.setFileLoadAddr(id, 0x10000)).toThrow(RangeError);
      expect(() => store.setFileLoadAddr(id, 1.5)).toThrow(RangeError);
    });

    it("addFile rejects bytes exceeding the 128KB storage cap (REQ §6.1)", async () => {
      const { store } = await freshStore();
      const over = new Uint8Array(128 * 1024 + 1);
      expect(() =>
        store.addFile({ name: "big", bytes: over, loadAddr: 0 }),
      ).toThrow(RangeError);
      // At the cap exactly: accepted.
      const atCap = new Uint8Array(128 * 1024);
      expect(() =>
        store.addFile({ name: "ok", bytes: atCap, loadAddr: 0 }),
      ).not.toThrow();
    });

    it("file order persists in UiState and restores on boot", async () => {
      const { backend, store } = await freshStore();
      store.addFile({ name: "a", bytes: new Uint8Array(), loadAddr: 0 });
      store.addFile({ name: "b", bytes: new Uint8Array(), loadAddr: 0 });
      store.addFile({ name: "c", bytes: new Uint8Array(), loadAddr: 0 });
      const ids = store.files.map((f) => f.id);
      store.reorderFiles([ids[2], ids[0]]);
      await flush();
      // Restart with the same backend.
      const store2 = await createAppStore({
        backend,
        loop: makeStubLoop(),
        bus: makeStubBus(),
        dbg: makeStubDbg(),
      });
      expect(store2.files.map((f) => f.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    it("boot autoload primes memory when files exist with autoload=true", async () => {
      const backend = new MemoryBackend();
      await backend.putFile({
        id: "boot1",
        name: "boot.bin",
        bytes: new Uint8Array([0xc3, 0x00, 0x80]),
        loadAddr: 0x0000,
        autoload: true,
      });
      const bus = makeStubBus();
      const store = await createAppStore({
        backend,
        loop: makeStubLoop(),
        bus,
        dbg: makeStubDbg(),
      });
      expect(bus.mem[0x0000]).toBe(0xc3);
      expect(bus.mem[0x0001]).toBe(0x00);
      expect(bus.mem[0x0002]).toBe(0x80);
      // Session marker should reflect the boot autoload.
      expect(store.fileSessions.boot1?.lastLoadedAddr).toBe(0);
    });
  });

  describe("cpuState (REQ §6.5)", () => {
    it("samples dbg.state() at boot so the section has a value to render", async () => {
      const { store, dbg } = await freshStore();
      dbg.setNext({ pc: 0x1234 });
      // Boot already happened; current snapshot reflects pre-setNext state.
      expect(store.cpuState().pc).toBe(0);
      // atInstructionBoundary starts false — boot is not a real boundary.
      expect(store.atInstructionBoundary()).toBe(false);
    });

    it("refreshes cpuState on every pause (boundary or not)", async () => {
      const { store, loop, dbg } = await freshStore();
      dbg.setNext({ pc: 0x1234 });
      loop.emitPause({ kind: "user" });
      expect(store.cpuState().pc).toBe(0x1234);
      dbg.setNext({ pc: 0x5678 });
      loop.emitPause({ kind: "user" });
      expect(store.cpuState().pc).toBe(0x5678);
    });

    it("sets atInstructionBoundary=true only when step-complete follows an onInstruction", async () => {
      const { store, loop, dbg } = await freshStore();
      // step-complete WITHOUT prior onInstruction (e.g. stepHC that didn't
      // land on M1_T3_1) → not a boundary.
      dbg.setNext({ pc: 0x100 });
      loop.emitPause({ kind: "step-complete" });
      expect(store.atInstructionBoundary()).toBe(false);

      // onInstruction then step-complete → boundary.
      dbg.setNext({ pc: 0x200 });
      loop.emitInstruction(mkTrace());
      loop.emitPause({ kind: "step-complete" });
      expect(store.atInstructionBoundary()).toBe(true);

      // user-pause AFTER an instruction is NOT a boundary — reason kind
      // gates it (user clicking pause mid-run is arbitrary timing).
      dbg.setNext({ pc: 0x300 });
      loop.emitInstruction(mkTrace());
      loop.emitPause({ kind: "user" });
      expect(store.atInstructionBoundary()).toBe(false);
    });

    it("advances prevCpuStateAtBoundary only at boundary pauses", async () => {
      const { store, loop, dbg } = await freshStore();
      // Boundary pause #1 — first real boundary; baseline = boot snapshot (pc=0).
      dbg.setNext({ pc: 0x100 });
      loop.emitInstruction(mkTrace());
      loop.emitPause({ kind: "step-complete" });
      expect(store.prevCpuStateAtBoundary().pc).toBe(0);
      expect(store.cpuState().pc).toBe(0x100);

      // Non-boundary pause in between (user-pause, or unaligned stepHC).
      // Baseline must NOT update — otherwise the next boundary would
      // diff against a mid-instruction snapshot and falsely paint
      // every changed-since-then cell.
      dbg.setNext({ pc: 0x150 });
      loop.emitPause({ kind: "user" });
      expect(store.prevCpuStateAtBoundary().pc).toBe(0);
      expect(store.cpuState().pc).toBe(0x150); // values still refresh

      // Boundary pause #2 — baseline advances to the *previous boundary*
      // snapshot (0x100), not the intermediate user-pause snapshot.
      dbg.setNext({ pc: 0x200 });
      loop.emitInstruction(mkTrace());
      loop.emitPause({ kind: "step-complete" });
      expect(store.prevCpuStateAtBoundary().pc).toBe(0x100);
      expect(store.cpuState().pc).toBe(0x200);
    });
  });

  describe("breakpoints (REQ §6.2)", () => {
    it("starts with no breakpoints when storage is empty", async () => {
      const { store } = await freshStore();
      expect(store.breakpoints.length).toBe(0);
    });

    it("addBreakpoint appends, persists, and pushes the full list to the loop", async () => {
      const { backend, store, loop } = await freshStore();
      store.addBreakpoint({ kind: "pc-range", lo: 0x8000, hi: 0x80ff });
      await flush();
      expect(store.breakpoints.length).toBe(1);
      const bp = store.breakpoints[0];
      expect(bp).toMatchObject({
        kind: "pc-range",
        lo: 0x8000,
        hi: 0x80ff,
        enabled: true,
      });
      expect(bp.id).toBeTruthy();
      // Loop received the same list it would evaluate against.
      expect(loop.lastBreakpoints.length).toBe(1);
      expect(loop.lastBreakpoints[0].id).toBe(bp.id);
      // Backend round-trips.
      const stored = await backend.loadBreakpoints();
      expect(stored.length).toBe(1);
      expect(stored[0]).toMatchObject({ lo: 0x8000, hi: 0x80ff });
    });

    it("addBreakpoint with hc-count target works", async () => {
      const { store, loop } = await freshStore();
      store.addBreakpoint({ kind: "hc-count", target: 1234 });
      expect(store.breakpoints[0]).toMatchObject({
        kind: "hc-count",
        target: 1234,
        enabled: true,
      });
      expect(loop.lastBreakpoints[0]).toMatchObject({ target: 1234 });
    });

    it("addBreakpoint honors enabled=false", async () => {
      const { store } = await freshStore();
      store.addBreakpoint({
        kind: "pc-range",
        lo: 0,
        hi: 0,
        enabled: false,
      });
      expect(store.breakpoints[0].enabled).toBe(false);
    });

    it("removeBreakpoint drops the entry, persists, and re-syncs the loop", async () => {
      const { backend, store, loop } = await freshStore();
      store.addBreakpoint({ kind: "pc-range", lo: 0, hi: 0xff });
      const id = store.breakpoints[0].id;
      store.removeBreakpoint(id);
      await flush();
      expect(store.breakpoints.length).toBe(0);
      expect(loop.lastBreakpoints.length).toBe(0);
      expect((await backend.loadBreakpoints()).length).toBe(0);
    });

    it("removeBreakpoint ignores unknown id", async () => {
      const { store } = await freshStore();
      store.removeBreakpoint("nonexistent");
      expect(store.breakpoints.length).toBe(0);
    });

    it("toggleBreakpoint flips enabled and re-syncs the loop", async () => {
      const { store, loop } = await freshStore();
      store.addBreakpoint({ kind: "hc-count", target: 100 });
      const id = store.breakpoints[0].id;
      expect(store.breakpoints[0].enabled).toBe(true);
      store.toggleBreakpoint(id);
      expect(store.breakpoints[0].enabled).toBe(false);
      expect(loop.lastBreakpoints[0].enabled).toBe(false);
      store.toggleBreakpoint(id);
      expect(store.breakpoints[0].enabled).toBe(true);
    });

    it("editBreakpoint patches lo/hi for pc-range", async () => {
      const { store, loop } = await freshStore();
      store.addBreakpoint({ kind: "pc-range", lo: 0x100, hi: 0x1ff });
      const id = store.breakpoints[0].id;
      store.editBreakpoint(id, { lo: 0x200, hi: 0x2ff });
      expect(store.breakpoints[0]).toMatchObject({ lo: 0x200, hi: 0x2ff });
      expect(loop.lastBreakpoints[0]).toMatchObject({ lo: 0x200, hi: 0x2ff });
    });

    it("editBreakpoint with unchanged values skips the loop re-push", async () => {
      const { store, loop } = await freshStore();
      store.addBreakpoint({ kind: "pc-range", lo: 0x100, hi: 0x200 });
      const id = store.breakpoints[0].id;
      const callsBefore = loop.setBreakpointsCalls;
      // Patch with the same values that are already set.
      store.editBreakpoint(id, { lo: 0x100, hi: 0x200 });
      // No write, no sync — matters for IndexedDB (M10) so blur on an
      // unchanged input doesn't burn a round-trip.
      expect(loop.setBreakpointsCalls).toBe(callsBefore);
      // Now make a real change and confirm sync DID fire.
      store.editBreakpoint(id, { lo: 0x101 });
      expect(loop.setBreakpointsCalls).toBe(callsBefore + 1);
    });

    it("editBreakpoint patches target for hc-count", async () => {
      const { store } = await freshStore();
      store.addBreakpoint({ kind: "hc-count", target: 100 });
      const id = store.breakpoints[0].id;
      store.editBreakpoint(id, { target: 9999 });
      expect(store.breakpoints[0]).toMatchObject({ target: 9999 });
    });

    it("editBreakpoint silently ignores patch fields not relevant to the kind", async () => {
      const { store } = await freshStore();
      store.addBreakpoint({ kind: "hc-count", target: 100 });
      const id = store.breakpoints[0].id;
      // `lo`/`hi` belong to pc-range. Passing them to an hc-count BP
      // is a programmatic mistake we tolerate (no throw) but don't
      // act on — saves the UI from having to inspect kind before
      // building a patch.
      store.editBreakpoint(id, { lo: 0x100, target: 200 });
      expect(store.breakpoints[0]).toMatchObject({
        kind: "hc-count",
        target: 200,
      });
    });

    it("addBreakpoint rejects out-of-range addresses and bad ranges", async () => {
      const { store } = await freshStore();
      expect(() =>
        store.addBreakpoint({ kind: "pc-range", lo: -1, hi: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        store.addBreakpoint({ kind: "pc-range", lo: 0, hi: 0x10000 }),
      ).toThrow(RangeError);
      expect(() =>
        store.addBreakpoint({ kind: "pc-range", lo: 0x200, hi: 0x100 }),
      ).toThrow(/lo .* must be ≤ hi/);
      expect(() =>
        store.addBreakpoint({ kind: "hc-count", target: -1 }),
      ).toThrow(RangeError);
      expect(() =>
        store.addBreakpoint({ kind: "hc-count", target: 1.5 }),
      ).toThrow(RangeError);
      // None of the rejections leaked a BP into the store.
      expect(store.breakpoints.length).toBe(0);
    });

    it("editBreakpoint rejects out-of-range patches", async () => {
      const { store } = await freshStore();
      store.addBreakpoint({ kind: "pc-range", lo: 0x100, hi: 0x200 });
      const id = store.breakpoints[0].id;
      expect(() => store.editBreakpoint(id, { lo: -1 })).toThrow(RangeError);
      expect(() => store.editBreakpoint(id, { hi: 0x10000 })).toThrow(
        RangeError,
      );
      // Cross-field violation: lo > hi after applying the patch.
      expect(() => store.editBreakpoint(id, { lo: 0x300 })).toThrow(
        /lo .* must be ≤ hi/,
      );
      // BP unchanged after each failed edit.
      expect(store.breakpoints[0]).toMatchObject({ lo: 0x100, hi: 0x200 });
    });

    it("restores stored breakpoints on boot and pushes them to the loop", async () => {
      const backend = new MemoryBackend();
      await backend.saveBreakpoints([
        {
          id: "preserved",
          kind: "pc-range",
          lo: 0x8000,
          hi: 0x80ff,
          enabled: true,
        },
        {
          id: "disabled",
          kind: "hc-count",
          target: 5000,
          enabled: false,
        },
      ]);
      const loop = makeStubLoop();
      const store = await createAppStore({
        backend,
        loop,
        bus: makeStubBus(),
        dbg: makeStubDbg(),
      });
      expect(store.breakpoints.length).toBe(2);
      expect(store.breakpoints[0].id).toBe("preserved");
      // Loop got the persisted set before any user action.
      expect(loop.lastBreakpoints.length).toBe(2);
    });
  });
});
