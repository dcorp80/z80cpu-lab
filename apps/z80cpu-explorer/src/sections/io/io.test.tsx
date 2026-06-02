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

describe("IO section — 8-bit view (REQ §6.7)", () => {
  it("toggle switches the body to a windowed 8-bit port grid", async () => {
    harness = await mount("Body");
    // 16-bit defaults: 1 + 1 + 1 = 3 rows.
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(3);
    harness.store.setIoViewMode("8bit");
    // 8-bit honours the same rowsBefore/After defaults.
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(3);
    // Cells use 2-hex-digit data-addr; the watchAddr=0 window wraps so
    // port 0x00 is visible (the watch row).
    expect(
      harness.container.querySelector('.hex-cell[data-addr="00"]'),
    ).not.toBeNull();
    // 4-digit cells from 16-bit mode should be gone.
    expect(
      harness.container.querySelector('.hex-cell[data-addr="0000"]'),
    ).toBeNull();
  });

  it("editing a port broadcasts the byte to all 256 high-byte aliases", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // Centre the window on port 0x42 so the cell is in the rendered window.
    harness.store.setIoWatchAddr(0x42);
    const cell = harness.container.querySelector(
      '.hex-cell[data-addr="42"]',
    ) as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "A5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Every alias holds the byte.
    for (let hi = 0; hi < 256; hi++) {
      expect(harness.bus.io[(hi << 8) | 0x42]).toBe(0xa5);
    }
  });

  it("advance from the window-last port bumps watchAddr by bpr", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // Defaults (watchAddr=0, bpr=16, rowsBefore=1, rowsAfter=1) → window
    // covers 0xF0..0x1F; last visible port is 0x1F.
    expect(harness.store.ioWatchAddr()).toBe(0);
    const cell = harness.container.querySelector(
      '.hex-cell[data-addr="1F"]',
    ) as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "11" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Bumped by bpr=16 so the next port (0x20) is brought into view.
    expect(harness.store.ioWatchAddr()).toBe(0x10);
  });

  it("advance from a mid-window port does not bump watchAddr", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // watchAddr=0; port 0x05 sits mid-window (well inside 0xF0..0x1F).
    const cell = harness.container.querySelector(
      '.hex-cell[data-addr="05"]',
    ) as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "22" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.ioWatchAddr()).toBe(0);
  });

  it("advance wraps watchAddr in 8-bit space at the address-space edge", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    harness.store.setIoWatchAddr(0xf0);
    // Window: rows 0xE0/0xF0/0x00 (third row wraps). Window last = 0x0F.
    const cell = harness.container.querySelector(
      '.hex-cell[data-addr="0F"]',
    ) as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "33" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // (0xF0 + 16) & 0xff = 0x00 — bump wraps in 8-bit space.
    expect(harness.store.ioWatchAddr()).toBe(0x00);
  });

  it("window wraps in 8-bit space near the address-space edges", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // watchAddr=0 → rowsBefore wraps to 0xF0..0xFF on the top row.
    expect(
      harness.container.querySelector('.hex-cell[data-addr="F0"]'),
    ).not.toBeNull();
    expect(
      harness.container.querySelector('.hex-cell[data-addr="00"]'),
    ).not.toBeNull();
    expect(
      harness.container.querySelector('.hex-cell[data-addr="10"]'),
    ).not.toBeNull();
  });

  it("watch input + bpr select stay present in both modes", async () => {
    harness = await mount("Header");
    const watch = () =>
      harness?.container.querySelector("input.watch-input-field");
    const bpr = () =>
      harness?.container.querySelector("select.bpr-select-field");
    expect(watch()).not.toBeNull();
    expect(bpr()).not.toBeNull();
    harness.store.setIoViewMode("8bit");
    expect(watch()).not.toBeNull();
    expect(bpr()).not.toBeNull();
  });

  it("watch input rejects values > 0xFF in 8-bit mode and accepts them in 16-bit", async () => {
    harness = await mount("Header");
    harness.store.setIoViewMode("8bit");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    // 16-bit mode default; switch into 8-bit BEFORE typing so the
    // maxValue prop is 0xFF for this commit attempt.
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "0100" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Rejected: watchAddr unchanged from its post-switch value (0).
    expect(harness.store.ioWatchAddr()).toBe(0);
    expect(input.classList.contains("is-invalid")).toBe(true);
    // Valid 8-bit value commits.
    fireEvent.input(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.ioWatchAddr()).toBe(0x80);
  });

  it("watch input displays the 2-digit form in 8-bit mode", async () => {
    harness = await mount("Header");
    harness.store.setIoWatchAddr(0x80);
    harness.store.setIoViewMode("8bit");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    expect(input.value).toBe("80");
  });

  it("switching 16-bit → 8-bit masks watchAddr to the low byte", async () => {
    harness = await mount("Body");
    harness.store.setIoWatchAddr(0x4080);
    expect(harness.store.ioWatchAddr()).toBe(0x4080);
    harness.store.setIoViewMode("8bit");
    expect(harness.store.ioWatchAddr()).toBe(0x80);
  });

  it("alias-mismatch tint lights when high-byte aliases disagree with io[port]", async () => {
    harness = await mount("Body");
    // Seed: io[0x0010]=0x11, io[0x4010]=0x22 → aliases disagree at port 0x10.
    harness.bus.io[0x0010] = 0x11;
    harness.bus.io[0x4010] = 0x22;
    harness.store.setIoViewMode("8bit");
    const mismatched = harness.container.querySelector(
      '.hex-cell[data-addr="10"]',
    );
    expect(mismatched?.classList.contains("is-alias-mismatch")).toBe(true);
    // After a broadcast edit through setIoBytePort8 the cue clears.
    harness.store.setIoBytePort8(0x10, 0x33);
    const cleared = harness.container.querySelector(
      '.hex-cell[data-addr="10"]',
    );
    expect(cleared?.classList.contains("is-alias-mismatch")).toBe(false);
  });

  it("folded summary swaps to the 8-bit header copy and shows the 2-digit watch", async () => {
    harness = await mount("FoldedSummary");
    harness.store.setIoWatchAddr(0x80);
    harness.store.setIoViewMode("8bit");
    const text = harness.container.textContent ?? "";
    expect(text).toContain("256 ports");
    expect(text).toContain("watch=80");
    expect(text).not.toContain("64K ports");
  });

  it("watch row + cell get the same highlight class as 16-bit mode", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    harness.store.setIoWatchAddr(0x8c);
    // Watch row is the one starting at 0x80 (bpr=16, 0x8c & 0xF0).
    const watchRow = harness.container.querySelector(".hex-row.is-watch-row");
    expect(watchRow).not.toBeNull();
    expect(watchRow?.querySelector(".hex-row-addr")?.textContent).toBe("80");
    // The cell at port 0x8c is the watch cell.
    const watchCell = watchRow?.querySelector('.hex-cell[data-addr="8C"]');
    expect(watchCell?.classList.contains("is-watch-cell")).toBe(true);
  });

  it("bpr widths keep the row count fixed and scale cells per row", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // Default rowsBefore=1 + watch + rowsAfter=1 = 3 rows in every width.
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(3);
    expect(harness.container.querySelectorAll(".hex-cell").length).toBe(3 * 16);
    harness.store.setIoBytesPerRow(32);
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(3);
    expect(harness.container.querySelectorAll(".hex-cell").length).toBe(3 * 32);
    harness.store.setIoBytesPerRow(64);
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(3);
    expect(harness.container.querySelectorAll(".hex-cell").length).toBe(3 * 64);
  });
});

describe("IO section — write protect (REQ §6.7)", () => {
  it("checkbox renders in the header and reflects store state", async () => {
    harness = await mount("Header");
    const cb = harness.container.querySelector(
      ".io-wp-checkbox",
    ) as HTMLInputElement;
    expect(cb).not.toBeNull();
    expect(cb.checked).toBe(false);
    harness.store.setIoWriteProtect(true);
    expect(cb.checked).toBe(true);
  });

  it("toggling the checkbox mirrors into store + bus", async () => {
    harness = await mount("Header");
    const cb = harness.container.querySelector(
      ".io-wp-checkbox",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    expect(harness.store.ioWriteProtect()).toBe(true);
    expect(harness.bus.ioWriteProtect()).toBe(true);
    fireEvent.click(cb);
    expect(harness.store.ioWriteProtect()).toBe(false);
    expect(harness.bus.ioWriteProtect()).toBe(false);
  });

  it("checkbox is disabled while the CPU is not paused", async () => {
    harness = await mount("Header");
    const cb = harness.container.querySelector(
      ".io-wp-checkbox",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(false);
    expect(
      harness.container
        .querySelector(".io-wp")
        ?.classList.contains("is-disabled"),
    ).toBe(false);
    harness.store.run();
    expect(cb.disabled).toBe(true);
    expect(
      harness.container
        .querySelector(".io-wp")
        ?.classList.contains("is-disabled"),
    ).toBe(true);
    // Pausing re-enables the toggle.
    harness.loop.emitPause({ kind: "user" });
    expect(cb.disabled).toBe(false);
  });
});
