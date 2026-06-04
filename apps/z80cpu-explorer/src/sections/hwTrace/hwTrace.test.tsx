// Happy-dom render tests for the HW-trace section. Mounts the real
// Solid store (stub loop / bus / dbg) and asserts folded-summary text,
// header controls, capture-mode wiring, snap-to-live wiring, and
// SignalRow glyph output. Scroll-detach behavior lives in the browser
// tier (M8a sub-task 5) — happy-dom can't honor scroll geometry fairly.

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
  it("renders the capture-mode select with ring + disabled options", async () => {
    const { container } = await open("header");
    const select = container.querySelector(
      ".hwt-capture-mode select",
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.value).toBe("ring");
    const opts = Array.from(select?.options ?? []).map((o) => o.value);
    expect(opts).toEqual(["ring", "disabled"]);
  });

  it("capture-mode select calls store.setHwTraceMode on change", async () => {
    const { container, store } = await open("header");
    const select = container.querySelector(
      ".hwt-capture-mode select",
    ) as HTMLSelectElement;
    select.value = "disabled";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.hwTraceMode()).toBe("disabled");
    expect(store.hwTrace.getMode()).toBe("disabled");
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

describe("hwTrace section — body", () => {
  it("renders the empty-state fallback on a fresh buffer", async () => {
    const { container } = await open("body");
    expect(container.textContent).toContain(STR.hwTrace.bodyEmpty);
    expect(container.querySelectorAll(".hwt-row").length).toBe(0);
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
    // windowLo=1, windowHi=10. Snapshot at HC=2 carries addr=0x4042 with the
    // change occurring AT HC=2 — so HC=1 has no prior info (carry-forward
    // undefined → tristate filler), HC=2..5 render "4042", HC=6..10 filler.
    expect(waveform).toBe(
      `${STR.hwTrace.glyphs.tristate}4042${STR.hwTrace.glyphs.busHoldFiller.repeat(5)}`,
    );
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

  it("renders full HC extent (1..store.hc()) regardless of cursor", async () => {
    // Under the new model the cursor controls scroll POSITION, not
    // render bounds — so the rendered waveform always spans
    // [max(1, hi-CAP+1), store.hc()] regardless of detach state.
    // Scroll-driven cursor changes live in the browser tier.
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
    expect(waveform?.length).toBe(200); // HC 1..200
    const high = STR.hwTrace.glyphs.high;
    const low = STR.hwTrace.glyphs.low;
    // Cells 1..101 high (initial + carried), 102..200 low.
    expect(waveform).toBe(high.repeat(101) + low.repeat(99));
  });
});
