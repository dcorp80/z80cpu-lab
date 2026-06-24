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
  it("shows PC / status / insns / capture on empty boot (no last-insn)", async () => {
    harness = await mount({ folded: true });
    const text = harness.container.textContent ?? "";
    expect(text).toContain("PC=0000");
    expect(text).toContain("paused");
    expect(text).toContain("0 insns");
    expect(text).toContain("capture: ring");
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
    expect(text).toContain("capture: ring");
  });

  it("flips the capture clause to 'off' when capture is disabled", async () => {
    harness = await mount({ folded: true });
    harness.store.setCapture(false);
    const text = harness.container.textContent ?? "";
    expect(text).toContain("capture: off");
    expect(text).not.toContain("last:");
  });

  it("capture clause is reactive — toggles live between 'ring' and 'off'", async () => {
    harness = await mount({ folded: true });
    expect(harness.container.textContent).toContain("capture: ring");
    harness.store.setCapture(false);
    expect(harness.container.textContent).toContain("capture: off");
    harness.store.setCapture(true);
    expect(harness.container.textContent).toContain("capture: ring");
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
      ".itrace-row:not(.is-preview):not(.is-current)",
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

  it("emits an empty tag cell for a normal multi-byte instruction", async () => {
    harness = await mount();
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0x100, bytes: [0x78], length: 1, m1Type: "normal" }),
    );
    // The tag span is always rendered so the grid keeps a stable HC
    // column position; CSS `.itrace-tag:empty` strips the chrome when
    // there's no tag content.
    const tagEl = harness.container.querySelector(".itrace-tag");
    expect(tagEl).not.toBeNull();
    expect(tagEl?.textContent).toBe("");
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

  it("×N badge appears on a folded record (collapseRepeats=true)", async () => {
    harness = await mount();
    // collapseRepeats defaults to true in freshStore — same HALT trace three times.
    const halt = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
    });
    harness.loop.emitInstruction(halt);
    harness.loop.emitInstruction(halt);
    harness.loop.emitInstruction(halt);
    harness.loop.emitPause({ kind: "step-complete" });
    // One ring record, badge showing ×3.
    expect(harness.store.traceRing.size()).toBe(1);
    const badge = harness.container.querySelector(".itrace-repeat-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(STR.instructionTrace.repeatBadge(3));
  });

  it("no ×N badge text when count === 1 (span always rendered but empty)", async () => {
    harness = await mount();
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0x100, bytes: [0x78], length: 1 }),
    );
    harness.loop.emitPause({ kind: "step-complete" });
    const badge = harness.container.querySelector(".itrace-repeat-badge");
    // Span is always present (holds the grid column); content is empty for count=1.
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("");
  });

  it("N separate rows with no badge when collapseRepeats is off", async () => {
    harness = await mount();
    // Turn off collapseRepeats (already paused at construction).
    harness.store.setCollapseRepeats(false);
    const halt = mkTrace({
      startAddr: 0x4000,
      bytes: [0x76],
      length: 1,
      m1Type: "halt",
    });
    harness.loop.emitInstruction(halt);
    harness.loop.emitInstruction(halt);
    harness.loop.emitInstruction(halt);
    harness.loop.emitPause({ kind: "step-complete" });
    const rows = harness.container.querySelectorAll(
      ".itrace-row:not(.is-preview):not(.is-current)",
    );
    expect(rows.length).toBe(3);
    // Badge spans are present (grid column holder) but all empty — no fold.
    for (const row of rows) {
      expect(row.querySelector(".itrace-repeat-badge")?.textContent).toBe("");
    }
  });
});

describe("instructionTrace section — PC preview", () => {
  it("anchors preview to the in-flight curr.nextPc at instruction boundary", async () => {
    harness = await mount();
    // Stage memory at 0x0100: 78 (LD A,B), 79 (LD A,C).
    harness.bus.mem[0x0100] = 0x78;
    harness.bus.mem[0x0101] = 0x79;
    // At boundary, dbg.curr is the *next* instruction (freshly
    // promoted at M1 T3_0): startAddr = nextPc = 0x0100, length=1
    // (just the M1 opcode). Both rows render at 0x0100.
    harness.dbg.setCurr({ startAddr: 0x0100, bytes: [0x78] });
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

  it("preview origin is 0 at cold boot when no instruction is in flight", async () => {
    harness = await mount();
    harness.bus.mem[0x0000] = 0x00; // NOP at 0
    // No setCurr — dbg.curr.length stays 0; currentInstruction is null
    // before the first emitPause and the preview origin falls back to 0.
    // The previously-used cpuState.pc fallback is gone because it slid
    // through operand fetches mid-instruction (the bug this design fixed).
    expect(harness.container.querySelector(".itrace-pc")?.textContent).toBe(
      "0000",
    );
  });

  it("preview anchor stays put across HC-stepping mid-instruction", async () => {
    harness = await mount();
    harness.bus.mem[0x0100] = 0x78; // LD A,B
    // Mid-instruction snapshot: dbg.curr is in flight at 0x0100 with the
    // M1 opcode captured. `curr.nextPc` mirrors `startAddr` until the
    // next M1's T1_0 overwrites it — so the preview origin equals the
    // in-flight instruction's start, regardless of what cpuState.pc says.
    harness.dbg.setCurr({ startAddr: 0x0100, bytes: [0x78] });
    harness.dbg.setNext({ pc: 0x0101 }); // live PC has slid past the opcode
    harness.loop.emitPause({ kind: "user" });
    expect(harness.store.atInstructionBoundary()).toBe(false);
    expect(harness.container.querySelector(".itrace-pc")?.textContent).toBe(
      "0100",
    );
    expect(harness.container.textContent).toContain("LD A,B");
  });

  it("preview advances in the 2-HC window after the next M1's T1_0", async () => {
    harness = await mount();
    // Memory: 0x0100 is still the in-flight instruction; 0x0200 is
    // where execution will head next (jump target etc.).
    harness.bus.mem[0x0200] = 0x79; // LD A,C
    // Transitional window: curr is still the previous instruction
    // (startAddr=0x0100) but its nextPc has been written by the next
    // M1's T1_0 to point at 0x0200. Preview should jump ahead to 0x0200
    // even though curr hasn't yet been promoted to prev.
    harness.dbg.setCurr({
      startAddr: 0x0100,
      bytes: [0xc3, 0x00, 0x02], // JP 0200 — 3 bytes captured
      nextPc: 0x0200,
    });
    harness.loop.emitPause({ kind: "user" });
    expect(harness.container.querySelector(".itrace-pc")?.textContent).toBe(
      "0200",
    );
    expect(harness.container.textContent).toContain("LD A,C");
  });

  it("re-renders preview when memory changes", async () => {
    harness = await mount();
    harness.dbg.setCurr({ startAddr: 0x0300, bytes: [0x00] });
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

describe("instructionTrace section — Current row", () => {
  it("renders the in-flight instruction with the > gutter marker", async () => {
    harness = await mount();
    // Stage curr: LD A,n with only the opcode byte captured so far.
    harness.dbg.setCurr({ startAddr: 0x0400, bytes: [0x3e] });
    harness.loop.emitPause({ kind: "user" });
    const row = harness.container.querySelector(".itrace-row.is-current");
    expect(row).not.toBeNull();
    const text = row?.textContent ?? "";
    expect(text).toContain(">"); // gutter marker
    expect(text).toContain("0400"); // start address
    expect(text).toContain("3E"); // captured byte
    // Disasm renders the partial encoding — operand byte is unknown,
    // so it shows as the disasm's "incomplete" sentinel rather than a
    // fabricated value.
    expect(text).toContain("LD A,");
  });

  it("renders at boundary too — shows the freshly-promoted next instruction", async () => {
    harness = await mount();
    // At boundary, curr was freshly init'd at M1 T3_0 of the next M1:
    // length=1, startAddr=nextPc of the trace that just fired. Current
    // row visually aliases the first preview row but with only the M1
    // opcode captured — the partial-vs-full distinction is the point.
    harness.dbg.setCurr({ startAddr: 0x0500, bytes: [0x00] });
    harness.loop.emitInstruction(
      mkTrace({ startAddr: 0xff, bytes: [0x00], length: 1, nextPc: 0x0500 }),
    );
    harness.loop.emitPause({ kind: "step-complete" });
    expect(harness.store.atInstructionBoundary()).toBe(true);
    const row = harness.container.querySelector(".itrace-row.is-current");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("0500");
  });

  it("renders an empty-bytes row at the very first HC pause", async () => {
    harness = await mount();
    // No setCurr — dbg.curr.length stays 0. After the first emitPause
    // the store still snapshots curr, so the Current row appears with
    // address 0000 and empty byte/disasm cells. Signals "CPU is here,
    // hasn't fetched yet" — distinct from "no in-flight" (pre-first-pause,
    // where the signal is still null and the row doesn't render).
    harness.loop.emitPause({ kind: "user" });
    const row = harness.container.querySelector(".itrace-row.is-current");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("0000");
  });

  it("does not render before the first pause (currentInstruction starts null)", async () => {
    harness = await mount();
    // No emitPause yet. Store's currentInstruction signal is initialized
    // to null at boot.
    expect(
      harness.container.querySelector(".itrace-row.is-current"),
    ).toBeNull();
  });

  it("renders the m1Type tag for non-normal in-flight instructions", async () => {
    harness = await mount();
    // NMI vector at 0x0066. The tag is known from the M1 start, so the
    // Current row should surface it even with just the M1 byte captured.
    harness.dbg.setCurr({
      startAddr: 0x0066,
      bytes: [0x00],
      m1Type: "nmi",
    });
    harness.loop.emitPause({ kind: "user" });
    const tagEl = harness.container.querySelector(
      ".itrace-row.is-current .itrace-tag",
    );
    expect(tagEl?.textContent).toBe(STR.instructionTrace.m1Tags.nmi);
  });

  it("does not synthesize a PREFIX tag for an in-flight length-1 DD/FD", async () => {
    harness = await mount();
    // Unlike the completed-trace synthesis in ExecutedRow, the in-flight
    // case can't tell wasted-prefix from a DDCB / DD nn chain that
    // hasn't extended yet — so we render no tag at length=1.
    harness.dbg.setCurr({ startAddr: 0x0200, bytes: [0xdd] });
    harness.loop.emitPause({ kind: "user" });
    const tagEl = harness.container.querySelector(
      ".itrace-row.is-current .itrace-tag",
    );
    expect(tagEl?.textContent).toBe("");
  });
});

describe("instructionTrace section — header step controls", () => {
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

describe("instructionTrace section — capture toggle", () => {
  let h: Harness | undefined;
  afterEach(() => h?.dispose());

  it("checkbox flips capture; unchecking from a populated ring clears it", async () => {
    h = await mount();
    h.loop.emitInstruction(mkTrace({ startAddr: 0x100, bytes: [0x78] }));
    h.loop.emitInstruction(mkTrace({ startAddr: 0x101, bytes: [0x79] }));
    expect(h.store.traceRing.size()).toBe(2);
    // Executed rows render under the default "ring" mode.
    expect(
      h.container.querySelectorAll(
        ".itrace-row:not(.is-preview):not(.is-current)",
      ).length,
    ).toBe(2);

    // The body slot doesn't include the header, so the section header
    // checkbox lives in its own mount.
    const headerHarness = await mountHeader();
    try {
      const cb = req(
        headerHarness.container.querySelector<HTMLInputElement>(
          `.itrace-capture-mode input[type=checkbox]`,
        ),
        "capture checkbox",
      );
      expect(cb.checked).toBe(true);
      fireEvent.click(cb);
      expect(headerHarness.store.capture()).toBe(false);
    } finally {
      headerHarness.dispose();
    }
  });

  it("body shows the capture-off message in place of executed rows when disabled", async () => {
    h = await mount();
    h.loop.emitInstruction(mkTrace({ startAddr: 0x100, bytes: [0x78] }));
    expect(
      h.container.querySelectorAll(
        ".itrace-row:not(.is-preview):not(.is-current)",
      ).length,
    ).toBe(1);
    h.store.setCapture(false);
    // After disable: rows gone, muted disabled string in their place.
    expect(
      h.container.querySelectorAll(
        ".itrace-row:not(.is-preview):not(.is-current)",
      ).length,
    ).toBe(0);
    expect(
      h.container.querySelector(".itrace-executed")?.textContent,
    ).toContain(STR.instructionTrace.executedDisabled);
  });

  it("checkbox disables while running (paused-only gate)", async () => {
    const headerHarness = await mountHeader();
    try {
      const cb = req(
        headerHarness.container.querySelector<HTMLInputElement>(
          `.itrace-capture-mode input[type=checkbox]`,
        ),
        "capture checkbox",
      );
      // Paused at boot.
      expect(cb.disabled).toBe(false);
      headerHarness.store.run();
      await flush();
      expect(cb.disabled).toBe(true);
    } finally {
      headerHarness.dispose();
    }
  });
});

describe("instructionTrace section — traceInstructions gate (owned by appShell)", () => {
  // The Trace-instructions checkbox itself lives in the appShell section's
  // live-pane; the toggle's effects on the InsnTrace header (greyed-out
  // step controls, greyed-out Capture, forced capture-off, restored
  // dbg.enabled) belong here.
  let h: Harness | undefined;
  afterEach(() => h?.dispose());

  it("turning off traceInstructions greys out Step, Step-N count input, and Capture in the header", async () => {
    const headerHarness = await mountHeader();
    try {
      const stepBtn = buttonByText(
        headerHarness.container,
        STR.instructionTrace.step,
      );
      const stepNBtn = buttonByText(
        headerHarness.container,
        STR.instructionTrace.stepN,
      );
      const countInput = req(
        headerHarness.container.querySelector<HTMLInputElement>(
          `input[aria-label="${STR.instructionTrace.stepCountLabel}"]`,
        ),
        "step-N count input",
      );
      const captureCb = req(
        headerHarness.container.querySelector<HTMLInputElement>(
          `.itrace-capture-mode input[type=checkbox]`,
        ),
        "capture checkbox",
      );
      // Default: tracking on → all enabled.
      expect(stepBtn.disabled).toBe(false);
      expect(stepNBtn.disabled).toBe(false);
      expect(countInput.disabled).toBe(false);
      expect(captureCb.disabled).toBe(false);

      headerHarness.store.setTraceInstructions(false);
      await flush();
      expect(stepBtn.disabled).toBe(true);
      expect(stepNBtn.disabled).toBe(true);
      expect(countInput.disabled).toBe(true);
      expect(captureCb.disabled).toBe(true);

      // Re-enabling tracking re-enables every control.
      headerHarness.store.setTraceInstructions(true);
      await flush();
      expect(stepBtn.disabled).toBe(false);
      expect(stepNBtn.disabled).toBe(false);
      expect(countInput.disabled).toBe(false);
      expect(captureCb.disabled).toBe(false);
    } finally {
      headerHarness.dispose();
    }
  });

  it("turning off traceInstructions forces capture off, clears the ring, and writes dbg.enabled=false", async () => {
    const backend = new MemoryBackend();
    const loop = makeStubLoop();
    const bus = makeStubBus();
    const dbg = makeStubDbg();
    const store = await createAppStore({ backend, loop, bus, dbg });
    loop.emitInstruction(mkTrace({ startAddr: 0x100, bytes: [0x78] }));
    expect(store.capture()).toBe(true);
    store.setTraceInstructions(false);
    expect(store.traceInstructions()).toBe(false);
    expect(store.capture()).toBe(false);
    expect(store.traceRing.size()).toBe(0);
    expect(dbg.enabled).toBe(false);
  });

  it("turning traceInstructions back on restores dbg.enabled but leaves capture off", async () => {
    const backend = new MemoryBackend();
    const loop = makeStubLoop();
    const bus = makeStubBus();
    const dbg = makeStubDbg();
    const store = await createAppStore({ backend, loop, bus, dbg });
    store.setTraceInstructions(false);
    store.setTraceInstructions(true);
    expect(store.traceInstructions()).toBe(true);
    expect(dbg.enabled).toBe(true);
    // Capture stays off — re-enabling tracking doesn't auto-restore it.
    expect(store.capture()).toBe(false);
  });

  it("Current row + Preview survive Capture-off (regression) but vanish on tracking-off", async () => {
    // Repro for the fixed regression: previously the gate keyed on
    // `traceRingMode !== "ring"`, so turning Capture off while keeping
    // tracking on wrongly hid Current/Preview even though dbg.curr was
    // still fresh. Now Capture-off keeps both visible and only
    // tracking-off suppresses them.
    h = await mount();
    // Stage an in-flight instruction on the stub dbg, then emit a pause
    // so the store's pause-edge handler copies dbg.curr into
    // currentInstruction (its source of truth).
    h.dbg.setCurr({
      startAddr: 0x100,
      bytes: [0x3e, 0x42],
      nextPc: 0x102,
    });
    h.loop.emitPause({ kind: "user" });
    await flush();
    expect(h.container.querySelector(".itrace-current")).not.toBeNull();

    // Tracking on, capture off → Current row + Preview still render
    // (regression check).
    h.store.setCapture(false);
    await flush();
    expect(h.container.querySelector(".itrace-current")).not.toBeNull();
    expect(
      h.container.querySelector(".itrace-preview")?.textContent ?? "",
    ).not.toContain(STR.instructionTrace.previewTrackingOff);

    // Tracking off → both vanish, preview shows tracking-off placeholder.
    h.store.setTraceInstructions(false);
    await flush();
    expect(h.container.querySelector(".itrace-current")).toBeNull();
    expect(
      h.container.querySelector(".itrace-preview")?.textContent ?? "",
    ).toContain(STR.instructionTrace.previewTrackingOff);
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

describe("instructionTrace section — run-time freeze", () => {
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
        harness.container.querySelectorAll(
          ".itrace-row:not(.is-preview):not(.is-current)",
        ).length,
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
        harness.container.querySelectorAll(
          ".itrace-row:not(.is-preview):not(.is-current)",
        ).length,
      ).toBe(1);
      // No row diff means no auto-pin scroll either; even firing the
      // queued rAF (throttle bump) shouldn't add rows — status is
      // still running.
      while (queued.length > 0) queued.shift()?.(0);
      expect(
        harness.container.querySelectorAll(
          ".itrace-row:not(.is-preview):not(.is-current)",
        ).length,
      ).toBe(1);

      // Pause flushes the throttle and re-runs the records memo. All
      // 26 rows render now.
      harness.loop.emitPause({ kind: "user" });
      expect(
        harness.container.querySelectorAll(
          ".itrace-row:not(.is-preview):not(.is-current)",
        ).length,
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
    // Anchor preview at 0x0400 via the in-flight snapshot — preview
    // origin = currentLine.nextPc, seeded from curr.startAddr.
    harness.dbg.setCurr({ startAddr: 0x0400, bytes: [0x00] });
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
    harness.dbg.setCurr({ startAddr: 0x0500, bytes: [0x00] });
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
    harness.dbg.setCurr({ startAddr: 0x0600, bytes: [0x00] });
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0x0600, hi: 0x0600 });
    harness.loop.emitPause({ kind: "user" });
    const row = harness.container.querySelector(".itrace-row.is-preview");
    expect(row?.classList.contains("has-bp")).toBe(true);
  });

  it("wider range BP also lights the marker but click adds a duplicate single-PC BP (never modifies the wider range)", async () => {
    harness = await mount();
    harness.bus.mem[0x0700] = 0x00;
    harness.dbg.setCurr({ startAddr: 0x0700, bytes: [0x00] });
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
      ".itrace-row:not(.is-preview):not(.is-current)",
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
