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
import { DEFAULT_MEMORY_PAGE_SIZE } from "../../config/defaults.ts";
import { MemoryBackend } from "../../storage/memory.ts";
import { STR } from "../../style/strings.ts";
import { VIRTUAL_FALLBACK_ROWS } from "../instructionTrace/virtualWindow.ts";

// Under happy-dom the scroll container has no measurable layout
// (clientHeight === 0), so HexGrid's virtualization renders the
// `VIRTUAL_FALLBACK_ROWS` (=50) starting at the page base. The
// grid memo still produces `pageSize / bytesPerRow` rows; this
// constant is just how many are mounted.
const RENDERED_ROWS_UNDER_HAPPY_DOM = VIRTUAL_FALLBACK_ROWS;
// `pageSize / bytesPerRow` rows per page; the watch row sits at
// index (watchRowAddr - pageBase) / bytesPerRow inside the page.
const DEFAULT_PAGE_ROWS = DEFAULT_MEMORY_PAGE_SIZE / 16;

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

  it("watch input commit also snaps the view to the watched page", async () => {
    harness = await mount("Header");
    const input = harness.container.querySelector(
      "input.watch-input-field",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "4321" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.store.memWatchAddr()).toBe(0x4321);
    // 4 KB page → pageBase(0x4321) = 0x4000.
    expect(harness.store.memViewPageBase()).toBe(0x4000);
  });
});

describe("Memory section — recall watch", () => {
  it("recall button is hidden by default (watch on view)", async () => {
    harness = await mount("Header");
    expect(harness.container.querySelector(".watch-recall-btn")).toBeNull();
  });

  it("recall button shows when memWatchOnView is false", async () => {
    harness = await mount("Header");
    harness.store.setMemWatchOnView(false);
    const btn = harness.container.querySelector(".watch-recall-btn");
    expect(btn).not.toBeNull();
    // Label shows the watch address (the place it would jump to).
    expect(btn?.textContent?.trim().endsWith("0000")).toBe(true);
  });

  it("clicking recall jumps viewPageBase to the watched page and bumps jumpVersion", async () => {
    harness = await mount("Header");
    // Stage: navigate the view away (simulate page-nav) and mark off-view.
    harness.store.setMemWatchAddr(0x4321); // also snaps view to 0x4000
    harness.store.setMemViewPageBase(0x8000); // user clicked page-nav `>`
    harness.store.setMemWatchOnView(false);
    expect(harness.store.memViewPageBase()).toBe(0x8000);
    const v0 = harness.store.memWatchJumpVersion();
    const btn = harness.container.querySelector(
      ".watch-recall-btn",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    // View snapped back to the watched page; jumpVersion bumped so the
    // body scroll-centers the watch row.
    expect(harness.store.memViewPageBase()).toBe(0x4000);
    expect(harness.store.memWatchAddr()).toBe(0x4321);
    expect(harness.store.memWatchJumpVersion()).toBeGreaterThan(v0);
  });

  it("recall hides again after the watch comes back into view", async () => {
    harness = await mount("Header");
    harness.store.setMemWatchOnView(false);
    expect(harness.container.querySelector(".watch-recall-btn")).not.toBeNull();
    harness.store.setMemWatchOnView(true);
    expect(harness.container.querySelector(".watch-recall-btn")).toBeNull();
  });
});

describe("Memory section — body grid", () => {
  it("renders the virtualization fallback window from the page base under happy-dom", async () => {
    harness = await mount("Body");
    // watchAddr defaults to 0 → page 0. Under happy-dom virtualization
    // renders only the fallback rows from the top. The page itself is
    // larger than what's mounted (`pageSize / bytesPerRow` rows).
    const rows = harness.container.querySelectorAll(".hex-row");
    expect(rows.length).toBe(
      Math.min(DEFAULT_PAGE_ROWS, RENDERED_ROWS_UNDER_HAPPY_DOM),
    );
    expect(rows[0].querySelector(".hex-row-addr")?.textContent).toBe("0000");
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
    // Page model: page base for 0x4033 (16 KB page) = 0x4000;
    // watch row addr 0x4020 sits at index (0x4020 - 0x4000)/32 = 1.
    expect(rows[1].querySelector(".hex-row-addr")?.textContent).toBe("4020");
    expect(rows[1].classList.contains("is-watch-row")).toBe(true);
    expect(rows[1].querySelectorAll(".hex-cell").length).toBe(32);
    const cells = rows[1].querySelectorAll(".hex-cell");
    expect(cells[0x13].classList.contains("is-watch-cell")).toBe(true);
  });

  it("switching width to 64 quadruples cells and aligns to 64-byte rows", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4045);
    harness.store.setMemBytesPerRow(64);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Page base for 0x4045 (16 KB page) = 0x4000; watch row 0x4040
    // sits at index (0x4040 - 0x4000)/64 = 1.
    expect(rows[1].querySelector(".hex-row-addr")?.textContent).toBe("4040");
    expect(rows[1].querySelectorAll(".hex-cell").length).toBe(64);
  });

  it("watch row lands at index (watchRowAddr - pageBase) / bpr inside the page", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4023);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Default page size = 4 KB → pageBase(0x4023) = 0x4000. The first
    // rendered row is the page base; the watch row 0x4020 sits at
    // index (0x4020 - 0x4000) / 16 = 2 within the page.
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

  it("watchAddr near 0 lands on page 0 starting at 0x0000", async () => {
    harness = await mount("Body");
    // The page model doesn't wrap inside a page: 0x0008 lives in page
    // 0x0000, and the first rendered row is at 0x0000 — distinct from
    // a hypothetical center-on-watch window that would have to wrap
    // around to fill rows above the watch.
    harness.store.setMemWatchAddr(0x0008);
    const rows = harness.container.querySelectorAll(".hex-row");
    expect(rows[0].querySelector(".hex-row-addr")?.textContent).toBe("0000");
    // Watch row = 0x0000 (aligned), index 0 within the page.
    expect(rows[0].classList.contains("is-watch-row")).toBe(true);
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

describe("Memory section — rapid entry", () => {
  // After a successful Enter commit, the grid's `advance` queues two
  // microtasks before clicking the next cell — give the test loop time
  // to drain them.
  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("Enter on a hex cell commits and advances focus to the next cell", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4020);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Watch row (page base 0x4000 + 2 × 16 = 0x4020), first cell = 0x4020.
    const cell = rows[2].querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "5A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.mem[0x4020]).toBe(0x5a);
    // Advance opens the next cell's input.
    await flushMicrotasks();
    const nextInput = harness.container.querySelector(
      '.hex-cell[data-addr="4021"] .hex-cell-input',
    );
    expect(nextInput).not.toBeNull();
  });

  it("Enter on an ASCII cell advances within the ASCII lane", async () => {
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
    expect(harness.bus.mem[0x4020]).toBe(0x5a);
    await flushMicrotasks();
    const nextAscii = harness.container.querySelector(
      '.hex-ascii-cell[data-addr="4021"] .hex-ascii-input',
    );
    expect(nextAscii).not.toBeNull();
    // Hex lane is independent — no hex input at 0x4021.
    expect(
      harness.container.querySelector(
        '.hex-cell[data-addr="4021"] .hex-cell-input',
      ),
    ).toBeNull();
  });

  it("Enter on invalid hex reverts text and KEEPS the cell focused", async () => {
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
    fireEvent.input(input, { target: { value: "ZZ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Byte unchanged, the same cell's input is still mounted (focus held).
    expect(harness.bus.mem[0x4020]).toBe(0x11);
    // Editor still open.
    expect(harness.container.querySelector(".hex-cell-input")).not.toBeNull();
  });

  it("Enter on a cell inside the page advances within the page (no page jump)", async () => {
    harness = await mount("Body");
    harness.store.setMemWatchAddr(0x4020);
    const rows = harness.container.querySelectorAll(".hex-row");
    // Watch row at idx 2 (page base 0x4000; (0x4020-0x4000)/16 = 2).
    const cell = rows[2].querySelector(".hex-cell") as HTMLElement;
    fireEvent.click(cell);
    const input = harness.container.querySelector(
      ".hex-cell-input",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "AA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.bus.mem[0x4020]).toBe(0xaa);
    // 0x4020 is NOT the page-last byte (page 0x4000 ends at 0x7FFF),
    // so watchAddr must NOT jump pages.
    expect(harness.store.memWatchAddr()).toBe(0x4020);
    await flushMicrotasks();
    // Next cell (0x4021) opens its input — within-page advance.
    const nextInput = harness.container.querySelector(
      '.hex-cell[data-addr="4021"] .hex-cell-input',
    );
    expect(nextInput).not.toBeNull();
  });
});

describe("Memory section — column toggles", () => {
  it("shows both columns by default", async () => {
    harness = await mount("Body");
    const row = harness.container.querySelector(".hex-row") as HTMLElement;
    expect(row.querySelectorAll(".hex-cell").length).toBe(16);
    expect(row.querySelectorAll(".hex-ascii-cell").length).toBe(16);
  });

  it("hides the hex bytes column when memShowBytes is false", async () => {
    harness = await mount("Body");
    harness.store.setMemShowBytes(false);
    const row = harness.container.querySelector(".hex-row") as HTMLElement;
    expect(row.querySelectorAll(".hex-cell").length).toBe(0);
    expect(row.querySelectorAll(".hex-ascii-cell").length).toBe(16);
    expect(row.querySelector(".hex-row-addr")).not.toBeNull();
  });

  it("hides the ASCII column when memShowAscii is false", async () => {
    harness = await mount("Body");
    harness.store.setMemShowAscii(false);
    const row = harness.container.querySelector(".hex-row") as HTMLElement;
    expect(row.querySelectorAll(".hex-cell").length).toBe(16);
    expect(row.querySelectorAll(".hex-ascii-cell").length).toBe(0);
    expect(row.querySelector(".hex-row-addr")).not.toBeNull();
  });

  it("body is empty (addr-only rows) when both columns are off", async () => {
    harness = await mount("Body");
    harness.store.setMemShowBytes(false);
    harness.store.setMemShowAscii(false);
    const row = harness.container.querySelector(".hex-row") as HTMLElement;
    expect(row.querySelectorAll(".hex-cell").length).toBe(0);
    expect(row.querySelectorAll(".hex-ascii-cell").length).toBe(0);
    expect(row.querySelector(".hex-row-addr")).not.toBeNull();
  });

  it("Header renders Hex and ASCII checkboxes, both checked by default", async () => {
    harness = await mount("Header");
    const checkboxes = harness.container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    const hexCb = Array.from(checkboxes).find(
      (cb) => cb.getAttribute("aria-label") === STR.memory.showBytesAriaLabel,
    );
    const asciiCb = Array.from(checkboxes).find(
      (cb) => cb.getAttribute("aria-label") === STR.memory.showAsciiAriaLabel,
    );
    expect(hexCb).toBeDefined();
    expect(asciiCb).toBeDefined();
    expect(hexCb?.checked).toBe(true);
    expect(asciiCb?.checked).toBe(true);
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
