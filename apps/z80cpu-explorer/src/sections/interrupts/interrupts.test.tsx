// Happy-dom render tests for the Interrupts section. Covers folded summary,
// INT vector input commit path, INT generator controls, and that the section
// is registered + appears in the default order.

import { fireEvent } from "@solidjs/testing-library";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBackend } from "../../storage/memory.ts";
import {
  createAppStore,
  type Store,
  StoreProvider,
} from "../../store/index.ts";
import { makeStubBus } from "../../store/testStubBus.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop } from "../../store/testStubLoop.ts";
import { defaultSectionIds } from "../sectionRegistry.ts";
import { interrupts } from "./index.tsx";

interface Harness {
  container: HTMLElement;
  store: Store;
  dispose: () => void;
}

async function mount(slot: "body" | "folded"): Promise<Harness> {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const dbg = makeStubDbg();
  const store = await createAppStore({ backend, loop, bus, dbg });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const Cmp = slot === "body" ? interrupts.Body : interrupts.FoldedSummary;
  if (!Cmp) throw new Error(`slot ${slot} missing`);
  const dispose = render(
    () => (
      <StoreProvider value={store}>
        <Cmp />
      </StoreProvider>
    ),
    container,
  );
  return {
    container,
    store,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("Interrupts section — registry", () => {
  it("ships in the default section order between io and hwTrace", () => {
    const ids = defaultSectionIds();
    const ix = ids.indexOf("interrupts");
    expect(ix).toBeGreaterThan(0);
    expect(ids[ix - 1]).toBe("io");
    expect(ids[ix + 1]).toBe("hwTrace");
  });
});

describe("Interrupts section — folded summary", () => {
  it("renders the current INT vector byte in hex (default FF)", async () => {
    harness = await mount("folded");
    expect(harness.container.textContent).toContain("INT vector FF");
  });

  it("reflects setIntVector updates", async () => {
    harness = await mount("folded");
    harness.store.setIntVector(0x42);
    await Promise.resolve();
    expect(harness.container.textContent).toContain("INT vector 42");
  });
});

describe("Interrupts section — body", () => {
  it("renders an INT vector input showing the committed value", async () => {
    harness = await mount("body");
    const input = harness.container.querySelector(
      "input.interrupts-vector-input",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("FF");
  });

  it("Enter on a valid hex value commits via store.setIntVector", async () => {
    harness = await mount("body");
    const input = harness.container.querySelector(
      "input.interrupts-vector-input",
    ) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "7e" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.inputPins.intVector).toBe(0x7e);
  });

  it("rejects values above the byte cap at the input (Enter on FFF leaves the committed vector unchanged)", async () => {
    // HexAddrInput's maxValue=0xFF gate refuses the parse, so
    // store.setIntVector is never called and the committed value
    // stays at whatever it was before the user typed. Stage a
    // non-default first so the assertion isn't satisfied by the
    // 0xFF construction default — that would let the test pass even
    // if the parse rejection silently broke.
    harness = await mount("body");
    harness.store.setIntVector(0x42);
    const input = harness.container.querySelector(
      "input.interrupts-vector-input",
    ) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "FFF" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.inputPins.intVector).toBe(0x42);
  });
});

describe("Interrupts section — INT generator controls", () => {
  it("renders the enable checkbox (unchecked by default)", async () => {
    harness = await mount("body");
    const cb = harness.container.querySelector(
      "input.interrupts-gen-enabled-checkbox",
    ) as HTMLInputElement;
    expect(cb).not.toBeNull();
    expect(cb.checked).toBe(false);
  });

  it("renders period and pulse-width inputs", async () => {
    harness = await mount("body");
    expect(
      harness.container.querySelector("input#interrupts-gen-period"),
    ).not.toBeNull();
    expect(
      harness.container.querySelector("input#interrupts-gen-pulsewidth"),
    ).not.toBeNull();
  });

  it("checking the enabled checkbox calls store.setIntGen({ enabled: true })", async () => {
    harness = await mount("body");
    const cb = harness.container.querySelector(
      "input.interrupts-gen-enabled-checkbox",
    ) as HTMLInputElement;
    fireEvent.change(cb, { target: { checked: true } });
    await Promise.resolve();
    expect(harness.store.intGen().enabled).toBe(true);
  });

  it("period input: Enter with valid integer commits via store.setIntGen", async () => {
    harness = await mount("body");
    const input = harness.container.querySelector(
      "input#interrupts-gen-period",
    ) as HTMLInputElement;
    // Must be > pulseWidth (default 64) so not rejected.
    fireEvent.keyDown(input, {
      key: "Enter",
      currentTarget: { value: "500" },
      target: { value: "500" },
    });
    // Commit-on-keyDown uses e.currentTarget.value; simulate via direct
    // input event + keyDown.
    fireEvent.input(input, { target: { value: "500" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(harness.store.intGen().period).toBe(500);
  });

  it("pulse-width input: Enter with valid integer commits via store.setIntGen", async () => {
    harness = await mount("body");
    const input = harness.container.querySelector(
      "input#interrupts-gen-pulsewidth",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "32" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(harness.store.intGen().pulseWidth).toBe(32);
  });

  it("generator controls are disabled while running", async () => {
    harness = await mount("body");
    harness.store.run();
    await Promise.resolve();
    const cb = harness.container.querySelector(
      "input.interrupts-gen-enabled-checkbox",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });
});

describe("Interrupts section — folded summary with generator", () => {
  it("shows only the vector when generator is disabled", async () => {
    harness = await mount("folded");
    expect(harness.container.textContent).toContain("INT vector FF");
    expect(harness.container.textContent).not.toContain("gen");
  });

  it("shows period/pulseWidth in the folded summary when generator is enabled", async () => {
    harness = await mount("folded");
    harness.store.setIntGen({ enabled: true, period: 200, pulseWidth: 10 });
    await Promise.resolve();
    expect(harness.container.textContent).toContain("gen 200/10 HC");
  });
});
