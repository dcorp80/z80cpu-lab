// Happy-dom render tests for the instruction-trace section. Drives a
// real Solid store backed by stubs; verifies folded summary text,
// executed-log rows, PC preview origin under the boundary heuristic
// (DESIGN option c), snap-to-live button visibility, and the `g`
// hotkey wiring. Scroll-detach behavior lives in the browser tier —
// happy-dom can't honor scrollTop/element heights fairly.

import { InstructionTrace } from "@dcorp80/z80cpu-debug";
import { fireEvent } from "@solidjs/testing-library";
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
import { makeStubBus } from "../../store/testStubBus.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop, type StubLoop } from "../../store/testStubLoop.ts";
import { STR } from "../../style/strings.ts";
import { buttonByText, flush, req } from "../../test/dom.ts";
import { instructionTrace } from "./index.tsx";

async function mountHeader(): Promise<{
  container: HTMLElement;
  store: Store;
  loop: StubLoop;
  dispose: () => void;
}> {
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
  return {
    container,
    store,
    loop,
    dispose: () => {
      dispose();
      container.remove();
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

describe("instructionTrace section — header step controls (REQ §6.3)", () => {
  let h: Awaited<ReturnType<typeof mountHeader>> | undefined;
  afterEach(() => h?.dispose());

  it("Step forwards stepInstructions(1) to the loop", async () => {
    h = await mountHeader();
    buttonByText(h.container, STR.instructionTrace.step).click();
    expect(h.loop.lastCmd).toBe("stepInstructions");
    expect(h.loop.lastStepN).toBe(1);
  });

  it("Step N reads the count input and forwards", async () => {
    h = await mountHeader();
    const input = req(
      h.container.querySelector<HTMLInputElement>(
        `input[aria-label="${STR.instructionTrace.stepCountLabel}"]`,
      ),
      "step-N input",
    );
    fireEvent.input(input, { target: { value: "7" } });
    buttonByText(h.container, STR.instructionTrace.stepN).click();
    expect(h.loop.lastCmd).toBe("stepInstructions");
    expect(h.loop.lastStepN).toBe(7);
  });

  it("Step buttons disable while running, snap-to-live appears only when detached", async () => {
    h = await mountHeader();
    // Snap button hidden while live; step buttons enabled while paused.
    expect(h.container.querySelector(".itrace-snap")).toBeNull();
    const stepBtn = buttonByText(h.container, STR.instructionTrace.step);
    const stepNBtn = buttonByText(h.container, STR.instructionTrace.stepN);
    expect(stepBtn.disabled).toBe(false);
    expect(stepNBtn.disabled).toBe(false);
    // Enter running — step buttons must disable, snap stays hidden.
    h.store.run();
    await flush();
    expect(stepBtn.disabled).toBe(true);
    expect(stepNBtn.disabled).toBe(true);
    expect(h.container.querySelector(".itrace-snap")).toBeNull();
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

describe("instructionTrace section — preview click-to-BP", () => {
  it("clicking a preview address adds an exact-match PC breakpoint", async () => {
    harness = await mount();
    harness.bus.mem[0x0400] = 0x00; // NOP
    harness.bus.mem[0x0401] = 0x00; // NOP
    harness.dbg.setNext({ pc: 0x0400 });
    harness.loop.emitPause({ kind: "user" });
    const btn = harness.container.querySelector<HTMLButtonElement>(
      ".itrace-row.is-preview .itrace-addr-btn",
    );
    expect(btn).not.toBeNull();
    btn?.click();
    expect(harness.store.breakpoints.length).toBe(1);
    expect(harness.store.breakpoints[0]).toMatchObject({
      kind: "pc-range",
      lo: 0x0400,
      hi: 0x0400,
      enabled: true,
    });
  });

  it("clicking again removes the exact-match BP (toggle)", async () => {
    harness = await mount();
    harness.bus.mem[0x0500] = 0x00;
    harness.dbg.setNext({ pc: 0x0500 });
    harness.loop.emitPause({ kind: "user" });
    const btn = harness.container.querySelector<HTMLButtonElement>(
      ".itrace-row.is-preview .itrace-addr-btn",
    );
    btn?.click();
    expect(harness.store.breakpoints.length).toBe(1);
    btn?.click();
    expect(harness.store.breakpoints.length).toBe(0);
  });

  it("preview row gets has-bp class when an enabled pc-range BP covers the addr", async () => {
    harness = await mount();
    harness.bus.mem[0x0600] = 0x00;
    harness.dbg.setNext({ pc: 0x0600 });
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0x0600, hi: 0x0600 });
    harness.loop.emitPause({ kind: "user" });
    const row = harness.container.querySelector(".itrace-row.is-preview");
    expect(row?.classList.contains("has-bp")).toBe(true);
  });

  it("wider range BP also lights the marker but click adds a duplicate single-PC BP (never modifies the wider range)", async () => {
    harness = await mount();
    harness.bus.mem[0x0700] = 0x00;
    harness.dbg.setNext({ pc: 0x0700 });
    // Wider range covering the previewed PC.
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0x0700, hi: 0x07ff });
    harness.loop.emitPause({ kind: "user" });
    const row = harness.container.querySelector(".itrace-row.is-preview");
    expect(row?.classList.contains("has-bp")).toBe(true);
    const btn = harness.container.querySelector<HTMLButtonElement>(
      ".itrace-row.is-preview .itrace-addr-btn",
    );
    btn?.click();
    // Original wider range BP is untouched; a new single-PC BP added.
    expect(harness.store.breakpoints.length).toBe(2);
    expect(harness.store.breakpoints[0]).toMatchObject({
      lo: 0x0700,
      hi: 0x07ff,
    });
    expect(harness.store.breakpoints[1]).toMatchObject({
      lo: 0x0700,
      hi: 0x0700,
    });
    // A second click removes the single-PC BP but leaves the wider range.
    btn?.click();
    expect(harness.store.breakpoints.length).toBe(1);
    expect(harness.store.breakpoints[0]).toMatchObject({
      lo: 0x0700,
      hi: 0x07ff,
    });
  });

  it("disabled BPs do not light the marker", async () => {
    harness = await mount();
    harness.bus.mem[0x0800] = 0x00;
    harness.dbg.setNext({ pc: 0x0800 });
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0x0800, hi: 0x0800 });
    const id = harness.store.breakpoints[0].id;
    harness.store.toggleBreakpoint(id); // disable
    harness.loop.emitPause({ kind: "user" });
    const row = harness.container.querySelector(".itrace-row.is-preview");
    expect(row?.classList.contains("has-bp")).toBe(false);
  });

  it("executed-log rows do not render a click target or marker", async () => {
    harness = await mount();
    harness.loop.emitInstruction(mkTrace({ startAddr: 0x0900, bytes: [0x00] }));
    harness.loop.emitPause({ kind: "user" });
    // Executed rows have no .is-preview class and no .itrace-addr-btn.
    const executedRow = harness.container.querySelector(
      ".itrace-row:not(.is-preview)",
    );
    expect(executedRow).not.toBeNull();
    expect(executedRow?.querySelector(".itrace-addr-btn")).toBeNull();
    expect(executedRow?.querySelector(".itrace-bp-marker")).toBeNull();
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
