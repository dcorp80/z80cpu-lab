// Happy-dom render tests for the CPU state section. Drives the same
// `cpuState.Body` / `cpuState.FoldedSummary` slots the SectionFrame
// mounts in production, with a real Solid store backed by a stub bus +
// stub dbg so we can drive the reactive `cpuState`, `prevCpuStateAtBoundary`,
// and `atInstructionBoundary` accessors via fake pause events.

import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBackend } from "../../storage/memory.ts";
import {
  createAppStore,
  type Store,
  StoreProvider,
} from "../../store/index.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop, type StubLoop } from "../../store/testStubLoop.ts";
import { cpuState } from "./index.tsx";

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
  store: Store;
  loop: StubLoop;
  dbg: ReturnType<typeof makeStubDbg>;
  container: HTMLElement;
  dispose: () => void;
}

async function mount(opts: { folded?: boolean } = {}): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const loop = makeStubLoop();
  const dbg = makeStubDbg();
  const store = await createAppStore({
    backend: new MemoryBackend(),
    loop,
    bus: makeStubBus(),
    dbg,
  });
  const ui = opts.folded
    ? () => (
        <StoreProvider value={store}>
          {cpuState.FoldedSummary && <cpuState.FoldedSummary />}
        </StoreProvider>
      )
    : () => (
        <StoreProvider value={store}>
          <cpuState.Body />
        </StoreProvider>
      );
  const dispose = render(ui, container);
  return {
    store,
    loop,
    dbg,
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

// Drive a boundary pause: stage the new CpuState fields, fire
// onInstruction (sets the "fired since pause" flag), then onPause with
// step-complete (so the store marks atInstructionBoundary=true).
function emitBoundary(
  h: Harness,
  patch: Partial<Parameters<Harness["dbg"]["setNext"]>[0]> = {},
): void {
  h.dbg.setNext(patch);
  h.loop.emitInstruction({} as never);
  h.loop.emitPause({ kind: "step-complete" });
}

let harness: Harness;
afterEach(() => harness?.dispose());

describe("cpuState section — folded summary", () => {
  it("shows AF/BC/DE/HL/PC/SP at boot", async () => {
    harness = await mount({ folded: true });
    // Boot snapshot is all zeros — formatted as 0000.
    const text = harness.container.textContent ?? "";
    expect(text).toContain("AF");
    expect(text).toContain("BC");
    expect(text).toContain("DE");
    expect(text).toContain("HL");
    expect(text).toContain("PC");
    expect(text).toContain("SP");
    expect(text).toContain("0000");
  });

  it("updates folded values when a boundary pause arrives", async () => {
    harness = await mount({ folded: true });
    emitBoundary(harness, { pc: 0x8000 });
    expect(harness.container.textContent).toContain("8000");
  });
});

describe("cpuState section — body", () => {
  it("renders main, shadow, flags, and interrupt rows", async () => {
    harness = await mount();
    // Main bank cells
    expect(harness.container.querySelector('[data-key="af"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="a"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="f"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="ix"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="ixh"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="r"]')).not.toBeNull();
    // Shadow bank
    expect(
      harness.container.querySelector('[data-key="af-shadow"]'),
    ).not.toBeNull();
    expect(
      harness.container.querySelector('[data-key="hl-shadow"]'),
    ).not.toBeNull();
    // Flag cells — one per labeled bit (S Z Y5 H X3 P/V N C = 8)
    const flagCells = harness.container.querySelectorAll(".cpuState-flag-cell");
    expect(flagCells.length).toBe(8);
    // Interrupt state
    expect(harness.container.querySelector('[data-key="iff1"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="iff2"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-key="im"]')).not.toBeNull();
  });

  it("starts dimmed (is-mid-instruction) since boot is not a real boundary", async () => {
    harness = await mount();
    const body = harness.container.querySelector(".cpuState-body");
    expect(body?.classList.contains("is-mid-instruction")).toBe(true);
  });

  it("removes the dim class and highlights changed cells after a boundary pause", async () => {
    harness = await mount();
    emitBoundary(harness, { pc: 0x1234 });
    const body = harness.container.querySelector(".cpuState-body");
    expect(body?.classList.contains("is-mid-instruction")).toBe(false);
    const pcCell = harness.container.querySelector('[data-key="pc"]');
    expect(pcCell?.classList.contains("is-changed")).toBe(true);
    // SP didn't change — no highlight.
    const spCell = harness.container.querySelector('[data-key="sp"]');
    expect(spCell?.classList.contains("is-changed")).toBe(false);
  });

  it("re-dims on a non-boundary pause while keeping .is-changed on the DOM (CSS suppresses visually)", async () => {
    harness = await mount();
    emitBoundary(harness, { pc: 0x1234 });
    // User pause mid-run — values refresh, atBoundary=false. PC went
    // 0 → 0x1234 (boundary) → 0x1500 (this pause); the diff baseline
    // (prevCpuStateAtBoundary) is still the boot snapshot (pc=0), so
    // PC differs from baseline and .is-changed stays on the cell.
    harness.dbg.setNext({ pc: 0x1500 });
    harness.loop.emitPause({ kind: "user" });
    const body = harness.container.querySelector(".cpuState-body");
    expect(body?.classList.contains("is-mid-instruction")).toBe(true);
    // Per DESIGN §3.7 "CSS owns the gating" — DOM stays consistent;
    // the .is-mid-instruction rule on the parent neutralises the
    // highlight visually without removing the class.
    const pcCell = harness.container.querySelector('[data-key="pc"]');
    expect(pcCell?.classList.contains("is-changed")).toBe(true);
  });

  it("propagates changes to combined AF when only F changes", async () => {
    harness = await mount();
    // First boundary establishes baseline.
    emitBoundary(harness, {
      main: { a: 0x12, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, f: 0x00 },
    });
    // Second boundary: flip a flag bit.
    emitBoundary(harness, {
      main: { a: 0x12, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, f: 0x80 },
    });
    expect(
      harness.container
        .querySelector('[data-key="f"]')
        ?.classList.contains("is-changed"),
    ).toBe(true);
    expect(
      harness.container
        .querySelector('[data-key="af"]')
        ?.classList.contains("is-changed"),
    ).toBe(true);
    // A didn't change.
    expect(
      harness.container
        .querySelector('[data-key="a"]')
        ?.classList.contains("is-changed"),
    ).toBe(false);
  });

  it("renders flag bits as 1/0 matching the F byte", async () => {
    harness = await mount();
    // F = 0b10100101 → S=1 Z=0 Y5=1 H=0 X3=0 P/V=1 N=0 C=1
    emitBoundary(harness, {
      main: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, f: 0xa5 },
    });
    const cells = Array.from(
      harness.container.querySelectorAll<HTMLElement>(".cpuState-flag-cell"),
    );
    const bits = cells.map(
      (c) => c.querySelector(".cpuState-flag-bit")?.textContent,
    );
    expect(bits).toEqual(["1", "0", "1", "0", "0", "1", "0", "1"]);
  });
});
