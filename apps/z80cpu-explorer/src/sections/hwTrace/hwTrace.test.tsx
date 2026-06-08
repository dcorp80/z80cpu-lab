// Happy-dom render tests for the HW-trace section. Mounts the real
// Solid store (stub loop / bus / dbg) and asserts folded-summary text,
// header controls, capture-mode wiring, snap-to-live wiring, and
// SignalRow glyph output. Scroll-detach behavior lives in the browser
// tier (M8a sub-task 5) — happy-dom can't honor scroll geometry fairly.

import { fireEvent } from "@solidjs/testing-library";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HW_TRACE_CONFIG } from "../../config/defaults.ts";
import {
  makeBusSample,
  recordSample,
} from "../../runloop/busSampleTestUtil.ts";
import { type BusSample, HwTraceBuffer } from "../../runloop/hwTrace.ts";
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
import { buttonByText, flush } from "../../test/dom.ts";
import { hwTrace } from "./index.tsx";

interface Harness {
  container: HTMLElement;
  store: Store;
  loop: StubLoop;
  dispose: () => void;
}

async function mount(slot: "header" | "folded" | "body"): Promise<Harness> {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const dbg = makeStubDbg();
  const hwTraceBuffer = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);
  const store = await createAppStore({
    backend,
    loop,
    bus,
    dbg,
    hwTrace: hwTraceBuffer,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const Slot =
    slot === "header"
      ? hwTrace.Header
      : slot === "folded"
        ? hwTrace.FoldedSummary
        : hwTrace.Body;
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
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()?.dispose();
});

async function open(slot: "header" | "folded" | "body"): Promise<Harness> {
  const h = await mount(slot);
  harnesses.push(h);
  return h;
}

function withOverrides(s: BusSample, p: Partial<BusSample>): BusSample {
  return { ...s, ...p };
}

describe("hwTrace section — folded summary", () => {
  it("shows the empty-buffer summary on fresh boot", async () => {
    const { container } = await open("folded");
    const text = container.querySelector(".hwt-folded-summary")?.textContent;
    expect(text).toBe(
      STR.hwTrace.foldedSummaryEmpty(
        STR.hwTrace.captureModeRing,
        STR.hwTrace.viewingLive,
      ),
    );
  });

  it("includes last HC once the buffer has activity", async () => {
    const { container, store, loop } = await open("folded");
    const sample = makeBusSample();
    recordSample(store.hwTrace, sample, 1);
    recordSample(store.hwTrace, withOverrides(sample, { nM1: 0 }), 5);
    loop.emitTick(5);
    const text = container.querySelector(".hwt-folded-summary")?.textContent;
    expect(text).toContain("last HC: 5");
    expect(text).toContain(`capture: ${STR.hwTrace.captureModeRing}`);
    expect(text).toContain(`viewing ${STR.hwTrace.viewingLive}`);
  });

  it("renders the disabled capture mode", async () => {
    const { container, store } = await open("folded");
    store.setHwTraceMode("disabled");
    const text = container.querySelector(".hwt-folded-summary")?.textContent;
    expect(text).toContain(`capture: ${STR.hwTrace.captureModeDisabled}`);
  });

  it("renders the detached viewing state with anchor HC", async () => {
    const { container, store } = await open("folded");
    store.detachHwTraceCursor(0xabcd);
    const text = container.querySelector(".hwt-folded-summary")?.textContent;
    expect(text).toContain("HC=ABCD");
  });
});

describe("hwTrace section — header", () => {
  it("renders the capture toggle as a checkbox, checked in ring mode", async () => {
    const { container } = await open("header");
    const cb = container.querySelector(
      ".hwt-capture-mode input[type=checkbox]",
    ) as HTMLInputElement | null;
    expect(cb).not.toBeNull();
    expect(cb?.checked).toBe(true); // default mode is ring
  });

  it("unchecking the capture toggle disables capture; rechecking re-enables", async () => {
    const { container, store } = await open("header");
    const cb = container.querySelector(
      ".hwt-capture-mode input[type=checkbox]",
    ) as HTMLInputElement;
    cb.checked = false;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.hwTraceMode()).toBe("disabled");
    expect(store.hwTrace.getMode()).toBe("disabled");

    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.hwTraceMode()).toBe("ring");
    expect(store.hwTrace.getMode()).toBe("ring");
  });

  it("snap-to-live button is hidden when the cursor is live", async () => {
    const { container } = await open("header");
    expect(container.querySelector(".hwt-snap")).toBeNull();
    expect(container.querySelector(".hwt-detached-badge")).toBeNull();
  });

  it("snap-to-live button + detached badge appear when cursor detached", async () => {
    const { container, store } = await open("header");
    store.detachHwTraceCursor(0x1234);
    const btn = container.querySelector(".hwt-snap") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe(STR.hwTrace.snapToLive);
    const badge = container.querySelector(".hwt-detached-badge");
    expect(badge?.textContent).toBe(STR.hwTrace.detachedBadge);
  });

  it("snap-to-live click resets the cursor to live", async () => {
    const { container, store } = await open("header");
    store.detachHwTraceCursor(0x99);
    const btn = container.querySelector(".hwt-snap") as HTMLButtonElement;
    btn.click();
    expect(store.cursors.hwTrace).toEqual({ mode: "live" });
  });
});

describe("hwTrace section — header step / zero controls (REQ §6.4)", () => {
  it("Step HC forwards stepHC(1)", async () => {
    const { container, loop } = await open("header");
    buttonByText(container, STR.hwTrace.stepHc).click();
    expect(loop.lastCmd).toBe("stepHC");
    expect(loop.lastStepN).toBe(1);
  });

  it("Step N HC reads the count input and forwards", async () => {
    const { container, loop } = await open("header");
    const input = container.querySelector<HTMLInputElement>(
      `input[aria-label="${STR.hwTrace.stepHcCountLabel}"]`,
    );
    if (!input) throw new Error("step-HC-N input");
    fireEvent.input(input, { target: { value: "42" } });
    buttonByText(container, STR.hwTrace.stepNHc).click();
    expect(loop.lastCmd).toBe("stepHC");
    expect(loop.lastStepN).toBe(42);
  });

  it("Zero HC forwards zeroHC", async () => {
    const { container, loop } = await open("header");
    buttonByText(container, STR.hwTrace.zeroHc).click();
    expect(loop.lastCmd).toBe("zeroHC");
  });

  it("Step / Zero buttons disable while running, capture toggle stays usable", async () => {
    const { container, store } = await open("header");
    const stepHcBtn = buttonByText(container, STR.hwTrace.stepHc);
    const stepNHcBtn = buttonByText(container, STR.hwTrace.stepNHc);
    const zeroBtn = buttonByText(container, STR.hwTrace.zeroHc);
    // Paused at boot — all enabled.
    expect(stepHcBtn.disabled).toBe(false);
    expect(stepNHcBtn.disabled).toBe(false);
    expect(zeroBtn.disabled).toBe(false);
    store.run();
    await flush();
    expect(stepHcBtn.disabled).toBe(true);
    expect(stepNHcBtn.disabled).toBe(true);
    expect(zeroBtn.disabled).toBe(true);
    // Capture checkbox is never status-gated.
    const cb = container.querySelector<HTMLInputElement>(
      ".hwt-capture-mode input[type=checkbox]",
    );
    expect(cb?.disabled).toBeFalsy();
  });
});

describe("hwTrace section — body", () => {
  it("renders the empty-state fallback on a fresh buffer", async () => {
    const { container } = await open("body");
    expect(container.textContent).toContain(STR.hwTrace.bodyEmpty);
    expect(container.querySelectorAll(".hwt-row").length).toBe(0);
  });

  it("shows a capture-off message (not the generic empty one) when disabled and empty", async () => {
    const { container, store } = await open("body");
    store.setHwTraceMode("disabled");
    expect(container.textContent).toContain(STR.hwTrace.bodyDisabled);
    expect(container.textContent).not.toContain(STR.hwTrace.bodyEmpty);
    expect(container.querySelectorAll(".hwt-row").length).toBe(0);
  });

  it("clears the ring (and the display) when capture is toggled off", async () => {
    const { container, store, loop } = await open("body");
    const sample = makeBusSample();
    recordSample(store.hwTrace, sample, 1);
    recordSample(store.hwTrace, withOverrides(sample, { nM1: 0 }), 5);
    loop.setHc(5);
    loop.emitTick(5);
    expect(container.querySelectorAll(".hwt-row").length).toBe(15);

    // Disabling capture discards the ring (after the save placeholder) so
    // a later run can't carry stale levels into the window as dead lines.
    store.setHwTraceMode("disabled");
    expect(store.hwTrace.isEmpty()).toBe(true);
    expect(container.querySelectorAll(".hwt-row").length).toBe(0);
    expect(container.textContent).toContain(STR.hwTrace.bodyDisabled);
  });

  it("renders one row per signal once activity has been captured", async () => {
    const { container, store, loop } = await open("body");
    const sample = makeBusSample();
    recordSample(store.hwTrace, sample, 1);
    recordSample(store.hwTrace, withOverrides(sample, { nM1: 0 }), 5);
    loop.setHc(5);
    loop.emitTick(5);
    const rows = container.querySelectorAll(".hwt-row");
    // 4 output bits + 4 tri + 5 inputs + 2 bus values = 15 rows.
    expect(rows.length).toBe(15);
  });

  it("renders glyphs for a signal that transitioned", async () => {
    const { container, store, loop } = await open("body");
    const a = makeBusSample(); // nM1=1
    recordSample(store.hwTrace, a, 1);
    // Drop nM1 low at HC=3.
    recordSample(store.hwTrace, withOverrides(a, { nM1: 0 }), 3);
    loop.setHc(5);
    loop.emitTick(5);
    const m1Row = Array.from(container.querySelectorAll(".hwt-row")).find(
      (el) => el.querySelector(".hwt-row-label")?.textContent === "nM1",
    ) as HTMLElement;
    expect(m1Row).toBeDefined();
    const waveform = m1Row.querySelector(".hwt-row-waveform")?.textContent;
    // windowLo = max(1, 5 - 100 + 1) = 1; windowHi = 5 → 5 cells.
    // HC=1 carries the first snapshot's nM1=1; HC=2 same; HC=3..5 nM1=0.
    expect(waveform).toBe(
      `${STR.hwTrace.glyphs.high.repeat(2)}${STR.hwTrace.glyphs.low.repeat(3)}`,
    );
  });

  it("renders a bus value with hex chars + filler", async () => {
    const { container, store, loop } = await open("body");
    const a = withOverrides(makeBusSample(), { addr: 0x4042 });
    recordSample(store.hwTrace, a, 2);
    loop.setHc(10);
    loop.emitTick(10);
    const addrRow = Array.from(container.querySelectorAll(".hwt-row")).find(
      (el) => el.querySelector(".hwt-row-label")?.textContent === "addr",
    ) as HTMLElement;
    const waveform = addrRow.querySelector(".hwt-row-waveform")?.textContent;
    // windowHi=10; windowLo clamps to oldestHc()=2 (the first record), NOT
    // HC=1 — store.hc() ran ahead of the ring, and rendering HC=1 would be a
    // carry-from-nothing "dead line." So HC=2..5 render "4042", HC=6..10
    // filler (9 cells, no leading tristate).
    expect(waveform).toBe(`4042${STR.hwTrace.glyphs.busHoldFiller.repeat(5)}`);
  });

  it("dims addr cells during DRAM refresh (nRFSH low) only", async () => {
    const { container, store, loop } = await open("body");
    const op = withOverrides(makeBusSample(), { addr: 0x0010, nRFSH: 1 });
    recordSample(store.hwTrace, op, 1);
    // Refresh cycle: nRFSH low, addr = I:R on the bus, starting HC=5.
    recordSample(
      store.hwTrace,
      withOverrides(op, { addr: 0x4242, nRFSH: 0 }),
      5,
    );
    // Back to operational at HC=9.
    recordSample(
      store.hwTrace,
      withOverrides(op, { addr: 0x0011, nRFSH: 1 }),
      9,
    );
    loop.setHc(12);
    loop.emitTick(12);

    const addrRow = Array.from(container.querySelectorAll(".hwt-row")).find(
      (el) => el.querySelector(".hwt-row-label")?.textContent === "addr",
    ) as HTMLElement;
    const waveform = addrRow.querySelector(".hwt-row-waveform") as HTMLElement;
    // window 1..12: "0010" (HC1-4) + "4242" (HC5-8, refresh) + "0011" (HC9-12).
    expect(waveform.textContent).toBe("001042420011");
    // Exactly the 4 refresh cells are dimmed — not the operational addrs.
    const dimmed = waveform.querySelectorAll(".hwt-bus-refresh");
    expect(dimmed.length).toBe(1);
    expect(dimmed[0].textContent).toBe("4242");

    // The dim treatment is addr-only: no other row carries a refresh span.
    const otherDimmed = Array.from(container.querySelectorAll(".hwt-row"))
      .filter(
        (el) => el.querySelector(".hwt-row-label")?.textContent !== "addr",
      )
      .flatMap((el) => Array.from(el.querySelectorAll(".hwt-bus-refresh")));
    expect(otherDimmed.length).toBe(0);
  });

  it("renders data as pre-transition tristate (sample.data=undefined)", async () => {
    const { container, store, loop } = await open("body");
    const a = makeBusSample(); // data=undefined by default
    recordSample(store.hwTrace, a, 1);
    recordSample(store.hwTrace, withOverrides(a, { data: 0xa5 }), 3);
    loop.setHc(6);
    loop.emitTick(6);
    const dataRow = Array.from(container.querySelectorAll(".hwt-row")).find(
      (el) => el.querySelector(".hwt-row-label")?.textContent === "data",
    ) as HTMLElement;
    const waveform = dataRow.querySelector(".hwt-row-waveform")?.textContent;
    // HC=1: data tristate; HC=2: still tristate (no change); HC=3,4: "A5";
    // HC=5,6: hold filler.
    expect(waveform).toBe(
      `${STR.hwTrace.glyphs.tristate.repeat(2)}A5${STR.hwTrace.glyphs.busHoldFiller.repeat(2)}`,
    );
  });

  it("renders the recorded HC extent (oldestHc..store.hc()) regardless of cursor", async () => {
    // The cursor controls scroll POSITION, not render bounds — so the
    // rendered range is independent of detach state. The left edge clamps
    // to oldestHc() (here 100), NOT HC=1: store.hc() ran to 200 but the
    // ring starts at 100, and cells 1..99 would be carry-from-nothing
    // "dead lines." Scroll-driven cursor changes live in the browser tier.
    const { container, store, loop } = await open("body");
    const a = makeBusSample();
    recordSample(store.hwTrace, a, 100);
    recordSample(store.hwTrace, withOverrides(a, { nM1: 0 }), 102);
    loop.setHc(200);
    loop.emitTick(200);
    store.detachHwTraceCursor(105); // doesn't shrink rendered range
    const m1Row = Array.from(container.querySelectorAll(".hwt-row")).find(
      (el) => el.querySelector(".hwt-row-label")?.textContent === "nM1",
    ) as HTMLElement;
    const waveform = m1Row.querySelector(".hwt-row-waveform")?.textContent;
    expect(waveform?.length).toBe(101); // HC 100..200
    const high = STR.hwTrace.glyphs.high;
    const low = STR.hwTrace.glyphs.low;
    // HC 100..101 high (record + carried), 102..200 low.
    expect(waveform).toBe(high.repeat(2) + low.repeat(99));
  });

  it("trims the dead-line prefix when capture starts after HC has advanced", async () => {
    // Repro of the reported bug: capture was OFF while HC ran ahead, so the
    // ring's first-ever record lands at HC≫1 (here 2000). The window must
    // start at that record (oldestHc), not HC=1 — otherwise [1, 2000)
    // renders as carry-from-nothing "dead lines" before the real signals.
    const { container, store, loop } = await open("body");
    const a = makeBusSample();
    recordSample(store.hwTrace, a, 2000);
    recordSample(store.hwTrace, withOverrides(a, { nM1: 0 }), 2002);
    loop.setHc(2002); // store.hc() === newestHc, as after an enable+Step
    loop.emitTick(2002);
    const m1Row = Array.from(container.querySelectorAll(".hwt-row")).find(
      (el) => el.querySelector(".hwt-row-label")?.textContent === "nM1",
    ) as HTMLElement;
    const waveform = m1Row.querySelector(".hwt-row-waveform")?.textContent;
    // Window = [oldestHc=2000, 2002] = 3 cells, NOT [1, 2002] = 2002 cells.
    expect(waveform?.length).toBe(3);
    expect(waveform).toBe(
      STR.hwTrace.glyphs.high.repeat(2) + STR.hwTrace.glyphs.low,
    );
  });
});
