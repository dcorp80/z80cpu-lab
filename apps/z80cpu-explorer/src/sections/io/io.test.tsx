// Happy-dom render tests for the IO section. The body shares the
// HexGrid + WatchAddrInput components with Memory (covered there);
// these tests pin down what's IO-specific: no ASCII column, distinct
// watch address from memory, IO-flavored folded summary.

import { fireEvent } from "@solidjs/testing-library";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBackend } from "../../storage/memory.ts";
import {
  createAppStore,
  type Store,
  StoreProvider,
} from "../../store/index.ts";
import { makeStubBus, type StubBus } from "../../store/testStubBus.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop, type StubLoop } from "../../store/testStubLoop.ts";
import { io } from "./index.tsx";

interface Harness {
  store: Store;
  loop: StubLoop;
  bus: StubBus;
  container: HTMLElement;
  dispose: () => void;
}

async function mount(
  slot: "Header" | "Body" | "FoldedSummary",
): Promise<Harness> {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const dbg = makeStubDbg();
  const store = await createAppStore({ backend, loop, bus, dbg });
  const container = document.createElement("div");
  document.body.appendChild(container);
  // biome-ignore lint/style/noNonNullAssertion: slot exists on the module.
  const Slot = io[slot]!;
  const dispose = render(
    () => (
      <StoreProvider value={store}>
        <Slot />
      </StoreProvider>
    ),
    container,
  );
  return {
    store,
    loop,
    bus,
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

let harness: Harness | undefined;
afterEach(() => harness?.dispose());

describe("IO section", () => {
  it("body omits the ASCII column", async () => {
    harness = await mount("Body");
    expect(harness.container.querySelector(".hex-row-ascii")).toBeNull();
    // But the hex grid itself renders.
    expect(
      harness.container.querySelectorAll(".hex-row").length,
    ).toBeGreaterThan(0);
  });

  it("watch input drives setIoWatchAddr, not setMemWatchAddr", async () => {
    harness = await mount("Header");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "00FE" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.ioWatchAddr()).toBe(0x00fe);
    expect(harness.store.memWatchAddr()).toBe(0);
  });

  it("body edits route through store.setIoByte (not setMemByte)", async () => {
    harness = await mount("Body");
    // Watch row's cell 0 = (watchAddr & 0xFFF0); pick a port-aligned
    // watch so the first cell of the watch row is the address we
    // want to write. IO defaults rowsBefore=1, so the watch row sits
    // at index 1 (not 2 like the deeper Memory window).
    harness.store.setIoWatchAddr(0x00f0);
    const rows = harness.container.querySelectorAll(".hex-row");
    expect(rows.length).toBe(3); // IO defaults: 1 + 1 + 1
    const cell = rows[1].querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "07" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.io[0x00f0]).toBe(0x07);
    // Mem at the same address untouched.
    expect(harness.bus.mem[0x00f0]).toBe(0xff);
  });

  it("folded summary shows port watch + last out/in", async () => {
    harness = await mount("FoldedSummary");
    harness.bus.setLastIoWrite({ addr: 0x00fe, value: 0x07 });
    harness.bus.setLastIoRead({ addr: 0x00fe, value: 0xbf });
    harness.loop.emitPause({ kind: "user" });
    const text = harness.container.textContent ?? "";
    expect(text).toContain("64K ports");
    expect(text).toContain("last out 00FE=07");
    expect(text).toContain("last in 00FE=BF");
  });
});
