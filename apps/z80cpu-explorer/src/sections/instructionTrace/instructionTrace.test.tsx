// Happy-dom render tests for the instruction-trace section. Drives a
// real Solid store backed by stubs; verifies folded summary text,
// executed-log rows, PC preview origin under the boundary heuristic
// (DESIGN option c), snap-to-live button visibility, and the `g`
// hotkey wiring. Scroll-detach behavior lives in the browser tier —
// happy-dom can't honor scrollTop/element heights fairly.

import { InstructionTrace } from "@dcorp80/z80cpu-debug";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { registerDefaultHotkeys } from "../../hotkeys/defaults.ts";
import { createHotkeyRegistry } from "../../hotkeys/registry.ts";
import { MemoryBackend } from "../../storage/memory.ts";
import {
  createAppStore,
  type Store,
  StoreProvider,
} from "../../store/index.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop, type StubLoop } from "../../store/testStubLoop.ts";
import { instructionTrace } from "./index.tsx";

function makeStubBus() {
  let v = 0xff;
  return {
    mem: new Uint8Array(0x10000).fill(0xff),
    intVector: () => v,
    setIntVector: (b: number) => {
      v = b & 0xff;
    },
  };
}

interface Harness {
  container: HTMLElement;
  store: Store;
  loop: StubLoop;
  bus: ReturnType<typeof makeStubBus>;
  dbg: ReturnType<typeof makeStubDbg>;
  dispose: () => void;
}

async function mount(opts: { folded?: boolean } = {}): Promise<Harness> {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const dbg = makeStubDbg();
  const store = await createAppStore({ backend, loop, bus, dbg });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const Slot = opts.folded
    ? instructionTrace.FoldedSummary
    : instructionTrace.Body;
  const dispose = render(
    () => (
      <StoreProvider value={store}>
        <Slot />
      </StoreProvider>
    ),
    container,
  );
  return {
    container,
    store,
    loop,
    bus,
    dbg,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

function mkTrace(opts: {
  startAddr?: number;
  bytes?: number[];
  length?: number;
  m1Type?: InstructionTrace["m1Type"];
  hc?: number;
  nextPc?: number;
}): InstructionTrace {
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

let harness: Harness | undefined;
afterEach(() => harness?.dispose());

describe("instructionTrace section — folded summary", () => {
  it("shows PC / status / insns on empty boot (no last-insn)", async () => {
    harness = await mount({ folded: true });
    const text = harness.container.textContent ?? "";
    expect(text).toContain("PC=0000");
    expect(text).toContain("paused");
    expect(text).toContain("0 insns");
    expect(text).not.toContain("last:");
  });

  it("appends `last: <disasm>` after the first instruction lands", async () => {
    harness = await mount({ folded: true });
    // LD A,B = 0x78. Push at hcAtComplete=42.
    harness.loop.setHc(42);
    harness.loop.emitInstruction(
      mkTrace({
        startAddr: 0x100,
        bytes: [0x78],
        length: 1,
        hc: 4,
        nextPc: 0x101,
      }),
    );
    const text = harness.container.textContent ?? "";
    expect(text).toContain("last:");
    expect(text).toContain("LD A,B");
    expect(text).toContain("1 insns");
  });
});

describe("instructionTrace section — executed log", () => {
  it("renders one row per ring record with HC, addr, bytes, disasm", async () => {
    harness = await mount();
    harness.loop.setHc(10);
    harness.loop.emitInstruction(
      mkTrace({
        startAddr: 0x100,
        bytes: [0x78],
        length: 1,
        hc: 4,
        nextPc: 0x101,
      }),
    );
    harness.loop.setHc(18);
    harness.loop.emitInstruction(
      mkTrace({
        startAddr: 0x101,
        bytes: [0x3e, 0x05],
        length: 2,
        hc: 7,
        nextPc: 0x103,
      }),
    );
    const rows = harness.container.querySelectorAll(
      ".itrace-row:not(.is-preview)",
    );
    expect(rows.length).toBe(2);
    const r0 = rows[0].textContent ?? "";
    expect(r0).toContain("10"); // hc decimal
    expect(r0).toContain("0100"); // start addr
    expect(r0).toContain("78"); // byte
    expect(r0).toContain("LD A,B");
    const r1 = rows[1].textContent ?? "";
    expect(r1).toContain("18");
    expect(r1).toContain("0101");
    expect(r1).toContain("3E 05");
    expect(r1).toContain("LD A,05");
  });

  it("renders a PREFIX tag for length-1 DD/FD traces", async () => {
    harness = await mount();
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0x200, bytes: [0xdd], length: 1, m1Type: "normal" }),
    );
    expect(harness.container.querySelector(".itrace-tag")?.textContent).toBe(
      "PREFIX",
    );
  });

  it("renders the NMI tag for nmi m1Type", async () => {
    harness = await mount();
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0x66, bytes: [0xfd], length: 1, m1Type: "nmi" }),
    );
    expect(harness.container.querySelector(".itrace-tag")?.textContent).toBe(
      "NMI",
    );
  });

  it("emits no tag for a normal multi-byte instruction", async () => {
    harness = await mount();
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0x100, bytes: [0x78], length: 1, m1Type: "normal" }),
    );
    expect(harness.container.querySelector(".itrace-tag")).toBeNull();
  });

  it("renders disasm bare-hex (no `h` suffix from upstream STYLE)", async () => {
    harness = await mount();
    // LD A,nn → opcode 3E + 8-bit operand. Upstream emits `LD A,FFh`;
    // bareHex wrapper strips the suffix.
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0, bytes: [0x3e, 0xff], length: 2 }),
    );
    const text = harness.container.textContent ?? "";
    expect(text).toContain("LD A,FF");
    expect(text).not.toMatch(/LD A,FFh/);
  });
});

describe("instructionTrace section — PC preview", () => {
  it("uses lastTrace.nextPc as origin at instruction boundary", async () => {
    harness = await mount();
    // Stage memory at 0x0100: 78 (LD A,B), 79 (LD A,C).
    harness.bus.mem[0x0100] = 0x78;
    harness.bus.mem[0x0101] = 0x79;
    // Boundary pause path: dbg.state's pc becomes nextPc+1 (per CLAUDE
    // timing model). We set cpuState.pc = 0x0101, lastTrace.nextPc = 0x0100,
    // and expect the preview to start at 0x0100.
    harness.dbg.setNext({ pc: 0x0101 });
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0xff, bytes: [0x00], length: 1, nextPc: 0x0100 }),
    );
    harness.loop.emitPause({ kind: "step-complete" });
    expect(harness.store.atInstructionBoundary()).toBe(true);
    const text = harness.container.textContent ?? "";
    // Preview origin label sits in the seam.
    expect(harness.container.querySelector(".itrace-pc")?.textContent).toBe(
      "0100",
    );
    expect(text).toContain("LD A,B");
  });

  it("uses live cpuState.pc as origin when mid-instruction", async () => {
    harness = await mount();
    harness.bus.mem[0x0200] = 0x79; // LD A,C
    harness.dbg.setNext({ pc: 0x0200 });
    // Non-boundary pause: user pauses mid-run. atInstructionBoundary
    // stays false; preview falls back to live cpuState.pc.
    harness.loop.emitPause({ kind: "user" });
    expect(harness.store.atInstructionBoundary()).toBe(false);
    expect(harness.container.querySelector(".itrace-pc")?.textContent).toBe(
      "0200",
    );
    expect(harness.container.textContent).toContain("LD A,C");
  });

  it("re-renders preview when memory changes", async () => {
    harness = await mount();
    harness.dbg.setNext({ pc: 0x0300 });
    harness.loop.emitPause({ kind: "user" });
    harness.bus.mem[0x0300] = 0x00; // NOP
    // Force memVersion bump by writing through a file:
    harness.store.addFile({
      name: "tweak.bin",
      bytes: new Uint8Array([0x78]), // LD A,B
      loadAddr: 0x0300,
    });
    harness.store.writeFileToMemory(harness.store.files[0].id);
    expect(harness.container.textContent).toContain("LD A,B");
  });
});

describe("instructionTrace section — cursor + snap-to-live", () => {
  it("snap-to-live button is hidden when cursor is live, shown when detached", async () => {
    // Header slot for this test
    const backend = new MemoryBackend();
    const loop = makeStubLoop();
    const bus = makeStubBus();
    const dbg = makeStubDbg();
    const store = await createAppStore({ backend, loop, bus, dbg });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <StoreProvider value={store}>
          <instructionTrace.Header />
        </StoreProvider>
      ),
      container,
    );
    expect(container.querySelector(".itrace-snap")).toBeNull();
    store.detachInstructionTraceCursor(123);
    // Solid flushes synchronously after the action.
    expect(container.querySelector(".itrace-snap")).not.toBeNull();
    expect(container.querySelector(".itrace-detached-badge")?.textContent).toBe(
      "detached",
    );
    (container.querySelector(".itrace-snap") as HTMLButtonElement).click();
    expect(store.cursors.instructionTrace).toEqual({ mode: "live" });
    expect(container.querySelector(".itrace-snap")).toBeNull();
    dispose();
    container.remove();
  });
});

describe("instructionTrace section — run-time freeze (REQ §7.5)", () => {
  // Same rAF-queue trick as the store test: take control of the
  // throttle's scheduler so we can pin down what the body sees while
  // running, then again after the user pauses.
  it("body does not add rows while running; full set appears on pause", async () => {
    const queued: Array<FrameRequestCallback> = [];
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    }) as typeof requestAnimationFrame;
    try {
      harness = await mount();
      // First instruction lands while still paused (boot state). Body
      // shows one row — proves the baseline is wired.
      harness.loop.emitInstruction(
        mkTrace({ startAddr: 0x100, bytes: [0x78] }),
      );
      expect(
        harness.container.querySelectorAll(".itrace-row:not(.is-preview)")
          .length,
      ).toBe(1);

      // Enter running. `store.run()` updates BOTH the loop's status
      // (the throttle bypass reads `loop.status()`) and the reactive
      // `status` signal the section's records memo gates on. Setting
      // only `loop.setStatus` would diverge the two.
      harness.store.run();
      for (let i = 0; i < 25; i++) {
        harness.loop.emitInstruction(
          mkTrace({ startAddr: 0x200 + i, bytes: [0x00] }),
        );
      }
      expect(harness.store.traceRing.size()).toBe(26);
      expect(
        harness.container.querySelectorAll(".itrace-row:not(.is-preview)")
          .length,
      ).toBe(1);
      // No row diff means no auto-pin scroll either; even firing the
      // queued rAF (throttle bump) shouldn't add rows — status is
      // still running.
      while (queued.length > 0) queued.shift()?.(0);
      expect(
        harness.container.querySelectorAll(".itrace-row:not(.is-preview)")
          .length,
      ).toBe(1);

      // Pause flushes the throttle and re-runs the records memo. All
      // 26 rows render now.
      harness.loop.emitPause({ kind: "user" });
      expect(
        harness.container.querySelectorAll(".itrace-row:not(.is-preview)")
          .length,
      ).toBe(26);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });
});

describe("instructionTrace section — g hotkey", () => {
  it("g snaps a detached instruction-trace cursor to live", async () => {
    const backend = new MemoryBackend();
    const loop = makeStubLoop();
    const bus = makeStubBus();
    const dbg = makeStubDbg();
    const store = await createAppStore({ backend, loop, bus, dbg });
    const registry = createHotkeyRegistry();
    registerDefaultHotkeys(registry, store);
    store.detachInstructionTraceCursor(777);
    expect(store.cursors.instructionTrace).toEqual({
      mode: "detached",
      anchorHc: 777,
    });
    const gBinding = registry
      .list()
      .find((b) => b.key === "g" && !b.shift && !b.ctrl && !b.alt && !b.meta);
    expect(gBinding).toBeDefined();
    gBinding?.action();
    expect(store.cursors.instructionTrace).toEqual({ mode: "live" });
  });
});
