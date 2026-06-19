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
    // Page model: pick a watch addr whose row is mounted
    // under happy-dom's 50-row virtualization fallback. Page base is
    // 0x0000 at any shipped IO page size; watch row 0x00F0 is at index
    // (0x00F0 - 0x0000)/16 = 15 — inside the fallback window.
    harness.store.setIoWatchAddr(0x00f0);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Watch row index = (0x00F0 - 0x0000) / 16 = 15.
    const cell = rows[15].querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "07" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.ioRead[0x00f0]).toBe(0x07);
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

describe("IO section — 8-bit view", () => {
  it("toggle switches the body to a scrollable 8-bit port grid (all 256 ports rendered)", async () => {
    harness = await mount("Body");
    // 16-bit uses the virtualized HexGrid (page model). Under
    // happy-dom the fallback window mounts 50 rows.
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(50);
    harness.store.setIoViewMode("8bit");
    // 8-bit renders all 256 ports as 16 rows × 16 cells (no pagination
    // — 256 ports fits in any page; no virtualization — the row count
    // is tiny). The viewport (`--hex-grid-visible-rows = 3`) shows ~3
    // rows at a time; the rest is reachable by scrolling.
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(16);
    // Cells use 2-hex-digit data-addr; both ends of the space are
    // mounted in the same DOM tree.
    expect(
      harness.container.querySelector('.hex-cell[data-addr="00"]'),
    ).not.toBeNull();
    expect(
      harness.container.querySelector('.hex-cell[data-addr="FF"]'),
    ).not.toBeNull();
    // 4-digit cells from 16-bit mode should be gone.
    expect(
      harness.container.querySelector('.hex-cell[data-addr="0000"]'),
    ).toBeNull();
  });

  it("8-bit grid uses the flow layout (no .hex-virt-spacer) so rows stack without collapsing", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // The 16-bit HexGrid virtualizes via `.hex-virt-spacer`; the 8-bit
    // `IoPortGrid` does NOT. If a future change accidentally moves the
    // `.hex-row { position: absolute }` rule out from under the spacer
    // scope, IoPortGrid's rows would all stack at top:0 and the body
    // would visually collapse to a single line.
    const grid = harness.container.querySelector(".hex-grid");
    expect(grid).not.toBeNull();
    expect(grid?.querySelector(".hex-virt-spacer")).toBeNull();
    // Rows are direct children of the grid; full 8-bit space.
    const rows = grid?.querySelectorAll(":scope > .hex-row");
    expect(rows?.length).toBe(16);
  });

  it("8-bit grid omits the page-nav row (PageNavRow not even rendered in Pane8Bit)", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // Sanity: page-nav buttons aren't part of the 8-bit body. The
    // 16-bit pane wraps `.hex-grid` in `.hex-section-body` with a
    // PageNavRow above; the 8-bit pane renders `<IoPortGrid>` directly.
    expect(harness.container.querySelector(".page-nav-row")).toBeNull();
  });

  it("16-bit grid uses .hex-virt-spacer (virtualization on)", async () => {
    harness = await mount("Body");
    const grid = harness.container.querySelector(".hex-grid");
    expect(grid).not.toBeNull();
    // Default mode is 16-bit; HexGrid wraps rows in the spacer.
    expect(grid?.querySelector(".hex-virt-spacer")).not.toBeNull();
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
      expect(harness.bus.ioRead[(hi << 8) | 0x42]).toBe(0xa5);
    }
  });

  it("advance steps to the next port and never bumps watchAddr (all 256 ports are mounted)", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // Edit port 0x1F → advance moves cell focus to 0x20. watchAddr
    // stays put — the whole 8-bit space is rendered, the viewport
    // scrolls naturally if the next cell was off-screen.
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
    expect(harness.bus.ioRead[0x1f]).toBe(0x11);
    expect(harness.store.ioWatchAddr()).toBe(0);
  });

  it("advance wraps 0xFF → 0x00 (no watchAddr bump)", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    harness.store.setIoWatchAddr(0xff);
    const cell = harness.container.querySelector(
      '.hex-cell[data-addr="FF"]',
    ) as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "33" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.ioRead[0xff]).toBe(0x33);
    // watchAddr is unchanged; the next-cell selector wraps to 0x00.
    expect(harness.store.ioWatchAddr()).toBe(0xff);
  });

  it("renders ports from both ends of the 8-bit space simultaneously", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // All 256 ports are in the DOM at once — the user scrolls the
    // viewport; no window centering or wrap-around required.
    for (const addr of ["00", "10", "F0", "FF"]) {
      expect(
        harness.container.querySelector(`.hex-cell[data-addr="${addr}"]`),
      ).not.toBeNull();
    }
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
    harness.bus.ioRead[0x0010] = 0x11;
    harness.bus.ioRead[0x4010] = 0x22;
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

  it("bpr widths keep the total cell count at 256 and re-shape rows × cols", async () => {
    harness = await mount("Body");
    harness.store.setIoViewMode("8bit");
    // The 8-bit grid renders the whole space (256 ports). Row count =
    // 256 / bpr; cells per row = bpr.
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(16);
    expect(harness.container.querySelectorAll(".hex-cell").length).toBe(256);
    harness.store.setIoBytesPerRow(32);
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(8);
    expect(harness.container.querySelectorAll(".hex-cell").length).toBe(256);
    harness.store.setIoBytesPerRow(64);
    expect(harness.container.querySelectorAll(".hex-row").length).toBe(4);
    expect(harness.container.querySelectorAll(".hex-cell").length).toBe(256);
  });
});

describe("IO section — split RD/WR", () => {
  // The checkbox itself moved to the App-shell section header;
  // coverage for its in-header behavior lives in appShell.test.tsx.
  // What's left here is the IO section's reaction to the persisted flag:
  // body layout and folded-summary text.

  it("body renders side-by-side RD/WR panes when split", async () => {
    harness = await mount("Body");
    expect(harness.container.querySelector(".io-split-body")).toBeNull();
    harness.store.updateSectionConfig("io", { splitIo: true });
    expect(harness.container.querySelector(".io-split-body")).not.toBeNull();
    expect(harness.container.querySelector(".io-pane-rd")).not.toBeNull();
    expect(harness.container.querySelector(".io-pane-wr")).not.toBeNull();
  });

  it("folded summary surfaces both watch addresses in split mode", async () => {
    harness = await mount("FoldedSummary");
    harness.store.setIoWatchAddr(0x4080);
    harness.store.updateSectionConfig("io", { splitIo: true });
    harness.store.setIoWatchAddrWrite(0x00fe);
    const text = harness.container.textContent ?? "";
    expect(text).toContain("split");
    expect(text).toContain("RD=4080");
    expect(text).toContain("WR=00FE");
  });

  it("RD and WR panes each get their own PageNavRow with independent watch state", async () => {
    harness = await mount("Body");
    harness.store.updateSectionConfig("io", { splitIo: true });
    // Two panes → two .page-nav-row instances.
    const navRows = harness.container.querySelectorAll(".page-nav-row");
    expect(navRows.length).toBe(2);
    // Locate the > buttons in each pane and click only the RD one.
    const rdPane = harness.container.querySelector(
      ".io-pane-rd",
    ) as HTMLElement;
    const wrPane = harness.container.querySelector(
      ".io-pane-wr",
    ) as HTMLElement;
    expect(rdPane).not.toBeNull();
    expect(wrPane).not.toBeNull();
    const rdNext = rdPane.querySelector(".page-nav-next") as HTMLButtonElement;
    fireEvent.click(rdNext);
    // Page-nav drives `viewPageBase`, not `watchAddr` — the watch
    // markers stay put. Only the RD view-page moved.
    const ioPageSize = harness.store.ioPageSize();
    expect(harness.store.ioViewPageBase()).toBe(ioPageSize);
    expect(harness.store.ioViewPageBaseWrite()).toBe(0);
    expect(harness.store.ioWatchAddr()).toBe(0);
    expect(harness.store.ioWatchAddrWrite()).toBe(0);
    // Now click WR pane's > → only WR view moves.
    const wrNext = wrPane.querySelector(".page-nav-next") as HTMLButtonElement;
    fireEvent.click(wrNext);
    expect(harness.store.ioViewPageBase()).toBe(ioPageSize);
    expect(harness.store.ioViewPageBaseWrite()).toBe(ioPageSize);
  });

  it("IO header no longer carries the page-size selector (moved to App-shell)", async () => {
    const headerHarness = await mount("Header");
    // Page size was relocated to the App-shell live-pane so the IO
    // header isn't crowded with cross-pane settings; appShell tests
    // assert the live-commit semantics.
    expect(
      headerHarness.container.querySelector(".appshell-page-select"),
    ).toBeNull();
    headerHarness.dispose();
  });
});
