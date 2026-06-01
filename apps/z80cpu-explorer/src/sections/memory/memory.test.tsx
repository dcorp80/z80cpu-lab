// Happy-dom render tests for the Memory section. Drives the real
// Solid store backed by stubs; verifies the watch input commit flow,
// row window rendering centered on the watch address, ASCII column
// glyphing, paused-only edit gates, and folded summary composition.
//
// Browser-tier behaviors (scrollIntoView on jump, real layout) live
// in memory.browser.test.tsx if we add one.

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
import { memory } from "./index.tsx";

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
  const Slot = memory[slot]!;
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

describe("Memory section — watch input", () => {
  it("commits a valid hex address on Enter and bumps the jump version", async () => {
    harness = await mount("Header");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    const v0 = harness.store.memWatchJumpVersion();
    fireEvent.input(input, { target: { value: "4020" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.memWatchAddr()).toBe(0x4020);
    expect(harness.store.memWatchJumpVersion()).toBeGreaterThan(v0);
  });

  it("commits on blur without bumping the jump version", async () => {
    harness = await mount("Header");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    const v0 = harness.store.memWatchJumpVersion();
    fireEvent.input(input, { target: { value: "8000" } });
    fireEvent.blur(input);
    expect(harness.store.memWatchAddr()).toBe(0x8000);
    expect(harness.store.memWatchJumpVersion()).toBe(v0);
  });

  it("reverts to the canonical hex form when input is unparseable", async () => {
    harness = await mount("Header");
    harness.store.setMemWatchAddr(0x4020);
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    // Filter keeps only [0-9a-fA-F$xXhH]; "zzzz" is empty after filter → parse null.
    fireEvent.input(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(harness.store.memWatchAddr()).toBe(0x4020);
    expect(input.value).toBe("4020");
  });

  it("Escape reverts local edit text and does not commit", async () => {
    harness = await mount("Header");
    harness.store.setMemWatchAddr(0x4020);
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "9999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(harness.store.memWatchAddr()).toBe(0x4020);
    expect(input.value).toBe("4020");
  });

  it("accepts $ / 0x / h notations via parseAddr16", async () => {
    harness = await mount("Header");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "$1234" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.memWatchAddr()).toBe(0x1234);
  });
});

describe("Memory section — body grid", () => {
  it("renders rowsBefore + 1 + rowsAfter rows by default", async () => {
    harness = await mount("Body");
    const rows = harness.container.querySelectorAll(".hex-row");
    // Memory defaults: 2 + 1 + 9 = 12.
    expect(rows.length).toBe(12);
  });

  it("renders 16 cells per row at default width", async () => {
    harness = await mount("Body");
    const rows = harness.container.querySelectorAll(".hex-row");
    expect(rows[0].querySelectorAll(".hex-cell").length).toBe(16);
    expect(rows[0].querySelectorAll(".hex-ascii-cell").length).toBe(16);
    expect(
      rows[0].querySelector(".hex-row-cells")?.classList.contains("cells-16"),
    ).toBe(true);
  });

  it("switching width to 32 doubles cells per row and re-aligns rows", async () => {
    harness = await mount("Body");
    // Pick an address straddling a 32-byte boundary so the test
    // proves the alignment math:
    //   16-byte alignment of 0x4033 → row 0x4030 (cell offset 0x03)
    //   32-byte alignment of 0x4033 → row 0x4020 (cell offset 0x13)
    harness.store.setMemWatchAddr(0x4033);
    harness.store.setMemBytesPerRow(32);
    const rows = harness.container.querySelectorAll(".hex-row");
    expect(rows[2].querySelector(".hex-row-addr")?.textContent).toBe("4020");
    expect(rows[2].classList.contains("is-watch-row")).toBe(true);
    expect(rows[2].querySelectorAll(".hex-cell").length).toBe(32);
    const cells = rows[2].querySelectorAll(".hex-cell");
    expect(cells[0x13].classList.contains("is-watch-cell")).toBe(true);
  });

  it("switching width to 64 quadruples cells and aligns to 64-byte rows", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4045);
    harness.store.setMemBytesPerRow(64);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Watch row = 0x4045 & ~63 = 0x4040.
    expect(rows[2].querySelector(".hex-row-addr")?.textContent).toBe("4040");
    expect(rows[2].querySelectorAll(".hex-cell").length).toBe(64);
  });

  it("centers the watch row at index rowsBefore (=2)", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4023);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Watch row = (watchAddr & 0xFFF0) = 0x4020. With rowsBefore=2,
    // the row at index 0 starts at 0x4020 - 32 = 0x4000.
    expect(rows[0].querySelector(".hex-row-addr")?.textContent).toBe("4000");
    expect(rows[2].querySelector(".hex-row-addr")?.textContent).toBe("4020");
    expect(rows[2].classList.contains("is-watch-row")).toBe(true);
  });

  it("highlights the cell at the exact watch byte (offset within the row)", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4023);
    const rows = harness.container.querySelectorAll(".hex-row");
    const watchCells = rows[2].querySelectorAll(".hex-cell.is-watch-cell");
    expect(watchCells.length).toBe(1);
    // Within the watch row, the watch cell is the third (0x4023 - 0x4020 = 3).
    const allCells = rows[2].querySelectorAll(".hex-cell");
    expect(allCells[3].classList.contains("is-watch-cell")).toBe(true);
  });

  it("wraps the start address past 0xFFFF", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x0008); // row 0x0000, before=2 → start=0xFFE0
    const rows = harness.container.querySelectorAll(".hex-row");
    expect(rows[0].querySelector(".hex-row-addr")?.textContent).toBe("FFE0");
    expect(rows[2].querySelector(".hex-row-addr")?.textContent).toBe("0000");
  });

  it("renders hex bytes from store.memByte", async () => {
    harness = await mount("Body");
    harness.bus.mem[0x4020] = 0xa5;
    harness.bus.mem[0x4021] = 0x5a;
    harness.store.setMemWatchAddr(0x4020);
    // Force a memVersion bump so the grid memo re-runs (the stub bus
    // doesn't fire reactivity on direct mem writes).
    harness.store.setMemByte(0x4020, 0xa5);
    harness.store.setMemByte(0x4021, 0x5a);
    const rows = harness.container.querySelectorAll(".hex-row");
    const watchRowCells = rows[2].querySelectorAll(".hex-cell");
    expect(watchRowCells[0].textContent).toBe("A5");
    expect(watchRowCells[1].textContent).toBe("5A");
  });

  it("renders ASCII glyph for printable bytes and '.' for non-printable", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4020);
    harness.store.setMemByte(0x4020, 0x41); // 'A'
    harness.store.setMemByte(0x4021, 0x01); // non-printable
    harness.store.setMemByte(0x4022, 0x7e); // '~'
    harness.store.setMemByte(0x4023, 0x80); // high-bit, non-printable
    const rows = harness.container.querySelectorAll(".hex-row");
    const asciiCells = rows[2].querySelectorAll(".hex-ascii-cell");
    expect(asciiCells[0].textContent).toBe("A");
    expect(asciiCells[1].textContent).toBe(".");
    expect(asciiCells[2].textContent).toBe("~");
    expect(asciiCells[3].textContent).toBe(".");
  });
});

describe("Memory section — cell editing", () => {
  it("opens an input on click of a hex cell when paused", async () => {
    harness = await mount("Body");
    expect(harness.store.status()).toBe("paused");
    const cell = harness.container.querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    // Initial text seeded with current byte's hex (default fill FF).
    expect(input.value).toBe("FF");
  });

  it("commits a hex edit on Enter via store.setMemByte", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4020);
    const rows = harness.container.querySelectorAll(".hex-row");
    const cell = rows[2].querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "5A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.mem[0x4020]).toBe(0x5a);
  });

  it("does NOT open the editor while running", async () => {
    harness = await mount("Body");
    harness.store.run();
    const cell = harness.container.querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    expect(harness.container.querySelector(".hex-cell-input")).toBeNull();
  });

  it("ASCII cell edit commits the character's byte code", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4020);
    const rows = harness.container.querySelectorAll(".hex-row");
    const ascii = rows[2].querySelector(".hex-ascii-cell") as HTMLElement;
    fireEvent.click(ascii);
    const input = harness.container.querySelector(
      ".hex-ascii-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Z" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.mem[0x4020]).toBe(0x5a); // 'Z' = 0x5A
  });

  it("Escape closes the editor without writing", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4020);
    harness.bus.mem[0x4020] = 0x11;
    harness.store.setMemByte(0x4020, 0x11);
    const rows = harness.container.querySelectorAll(".hex-row");
    const cell = rows[2].querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "FF" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(harness.bus.mem[0x4020]).toBe(0x11);
  });
});

describe("Memory section — folded summary", () => {
  it("shows watch address with no activity on fresh boot", async () => {
    harness = await mount("FoldedSummary");
    const text = harness.container.textContent ?? "";
    expect(text).toContain("64KB");
    expect(text).toContain("watch=0000");
    expect(text).toContain("no activity");
  });

  it("includes last write + last read once the bus has been touched", async () => {
    harness = await mount("FoldedSummary");
    harness.bus.setLastMemWrite({ addr: 0x4022, value: 0xa7 });
    harness.bus.setLastMemRead({ addr: 0x0042, value: 0x00 });
    harness.loop.emitPause({ kind: "user" });
    const text = harness.container.textContent ?? "";
    expect(text).toContain("last write 4022=A7");
    expect(text).toContain("last read 0042");
  });
});
