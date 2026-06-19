// Browser-mode tests for Memory section behaviors that need real
// layout — specifically, the page-pagination model:
//   - The virtualized HexGrid mounts a viewport-bounded row count
//     (not the full page worth of rows) and the spacer reserves the
//     full virtual scroll height.
//   - Page-nav button clicks jump watchAddr and the body re-renders
//     the destination page.
//   - Cross-page rapid-entry advance (M4): editing the last cell of
//     a page advances watchAddr to the next page's base AND scrolls
//     the new page's first row into view, so the next cell mounts
//     and the focus-follow click finds it.

import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BootedApp, bootApp } from "../../boot.tsx";
import { DEFAULT_MEMORY_PAGE_SIZE } from "../../config/defaults.ts";
import { MemoryBackend } from "../../storage/memory.ts";
import "../../styles.css";

let booted: BootedApp;
let dispose: () => void = () => {};

async function mountApp() {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  // MemoryBackend keeps each test isolated — without it IDB persists
  // section config (watchAddr, pageSize) across tests in the same
  // browser context and the second test boots with state from the
  // first.
  booted = await bootApp({ backend: new MemoryBackend() });
  const detachRender = render(booted.ui, container);
  dispose = () => {
    detachRender();
    booted.dispose();
    container.remove();
  };
}

beforeEach(async () => {
  await mountApp();
});

afterEach(() => {
  dispose();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("Memory section (browser smoke)", () => {
  it("Memory grid clamps to the configured viewport height (24 rows + padding)", async () => {
    const grid = memoryGrid();
    // Height = DEFAULT_MEMORY_VIEWPORT_ROWS × --hex-row-h + 8 px
    // = 24 × 20 + 8 = 488. Wired via the `--hex-grid-visible-rows`
    // CSS var that the section body sets inline; drift here means
    // the var didn't propagate (typo in the inline style key, or
    // the .hex-grid calc fell back to its default).
    expect(grid.getBoundingClientRect().height).toBeCloseTo(488, 0);
  });

  it("virtualizes the hex grid — mounted row count bounded by viewport, not page size", async () => {
    // Default page = 16 KB at 16 b/row = 1024 rows.
    const grid = document.querySelector<HTMLDivElement>(".hex-grid");
    expect(grid).not.toBeNull();
    if (!grid) return;
    const rowCount = grid.querySelectorAll(".hex-row").length;
    const totalPageRows = DEFAULT_MEMORY_PAGE_SIZE / 16;
    // Generous upper bound — visible rows + 2 × overscan + slack. Should
    // be well below the page's full row count when the page is large
    // enough to virtualize.
    expect(rowCount).toBeLessThan(120);
    expect(rowCount).toBeGreaterThan(0);
    // Spacer reflects full virtual height = rows × rowH.
    const spacer = grid.querySelector<HTMLDivElement>(".hex-virt-spacer");
    expect(spacer).not.toBeNull();
    if (!spacer) return;
    const rowH = Number.parseFloat(
      getComputedStyle(grid).getPropertyValue("--hex-row-h").trim(),
    );
    expect(rowH).toBeGreaterThan(0);
    expect(spacer.getBoundingClientRect().height).toBeCloseTo(
      totalPageRows * rowH,
      0,
    );
  });

  // Multiple sections render the same PageNavRow strings (Memory + IO
  // RD pane + IO WR pane all show e.g. "4000 >"). Scope every query to
  // the Memory section's frame, which `frame.tsx` labels via
  // `aria-labelledby="section-memory-title"`.
  const memorySection = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>(
      '[aria-labelledby="section-memory-title"]',
    );
    if (!el) throw new Error("Memory section not found");
    return el;
  };
  const memoryGrid = (): HTMLDivElement => {
    const el = memorySection().querySelector<HTMLDivElement>(".hex-grid");
    if (!el) throw new Error("Memory hex-grid not found");
    return el;
  };
  const btnByText = (root: HTMLElement, text: string): HTMLButtonElement => {
    const buttons = root.querySelectorAll<HTMLButtonElement>("button");
    for (const b of buttons) {
      if (b.textContent?.trim() === text) return b;
    }
    throw new Error(`button with text "${text}" not found`);
  };

  // Format a 16-bit addr as 4 uppercase hex digits (matches what the
  // page-nav buttons render).
  const hex4 = (n: number): string =>
    n.toString(16).toUpperCase().padStart(4, "0");

  it("page-nav `>` button jumps viewPageBase to the next page (watch stays put)", async () => {
    expect(booted.store.memWatchAddr()).toBe(0);
    expect(booted.store.memViewPageBase()).toBe(0);
    const nextBase = DEFAULT_MEMORY_PAGE_SIZE;
    btnByText(memorySection(), `${hex4(nextBase)} >`).click();
    await flush();
    expect(booted.store.memViewPageBase()).toBe(nextBase);
    // Watch marker is untouched — recall button restores the view.
    expect(booted.store.memWatchAddr()).toBe(0);
    const firstRow = memoryGrid().querySelector(".hex-row");
    expect(firstRow?.querySelector(".hex-row-addr")?.textContent).toBe(
      hex4(nextBase),
    );
  });

  it("page-nav `<<` is disabled on page 0; `>>` jumps view to the last page", async () => {
    const sec = memorySection();
    expect(btnByText(sec, "<<").disabled).toBe(true);
    btnByText(sec, ">>").click();
    await flush();
    const lastBase = 0x10000 - DEFAULT_MEMORY_PAGE_SIZE;
    expect(booted.store.memViewPageBase()).toBe(lastBase);
    expect(booted.store.memWatchAddr()).toBe(0);
    const sec2 = memorySection();
    expect(btnByText(sec2, ">>").disabled).toBe(true);
    expect(btnByText(sec2, "<<").disabled).toBe(false);
  });

  it("cross-page advance: editing the last byte of a page jumps to next page's first cell", async () => {
    // Pause is the default state. Pick a watch addr near the bottom of
    // page 0 so the last cell's row falls within virtualization's
    // overscan after a short scroll.
    const pageLast = DEFAULT_MEMORY_PAGE_SIZE - 1; // inclusive
    const nextBase = DEFAULT_MEMORY_PAGE_SIZE;
    const pageRows = DEFAULT_MEMORY_PAGE_SIZE / 16;
    booted.store.setMemWatchAddr(pageLast & 0xfff0);
    const grid = memoryGrid();
    const rowH = Number.parseFloat(
      getComputedStyle(grid).getPropertyValue("--hex-row-h").trim(),
    );
    // Scroll near the very bottom of the page so the last row + a
    // little above it are within the virtualization window.
    grid.scrollTop = (pageRows - 1) * rowH - 100;
    grid.dispatchEvent(new Event("scroll"));
    await sleep(50);
    const lastCell = grid.querySelector<HTMLElement>(
      `.hex-cell[data-addr="${hex4(pageLast)}"]`,
    );
    expect(lastCell).not.toBeNull();
    if (!lastCell) return;
    lastCell.click();
    await flush();
    await flush();
    const input = grid.querySelector<HTMLInputElement>(".hex-cell-input");
    expect(input).not.toBeNull();
    if (!input) return;
    input.value = "AA";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(booted.store.memByte(pageLast)).toBe(0xaa);
    expect(booted.store.memWatchAddr()).toBe(nextBase);
    await sleep(50);
    const nextCell = grid.querySelector(
      `.hex-cell[data-addr="${hex4(nextBase)}"]`,
    );
    expect(nextCell).not.toBeNull();
    const nextInput = nextCell?.querySelector(".hex-cell-input");
    expect(nextInput).not.toBeNull();
  });

  it("recall button: appears when page-nav moves away, click restores view", async () => {
    const sec = memorySection();
    // Default boot: watch at 0, view at page 0 → recall hidden.
    expect(sec.querySelector(".watch-recall-btn")).toBeNull();
    // Click `>` to advance the view; watch stays put → recall shows.
    btnByText(sec, `${hex4(DEFAULT_MEMORY_PAGE_SIZE)} >`).click();
    await flush();
    await sleep(50);
    const recall = sec.querySelector<HTMLButtonElement>(".watch-recall-btn");
    expect(recall).not.toBeNull();
    if (!recall) return;
    // Label includes the watch addr — clicking should land back there.
    expect(recall.textContent?.includes("0000")).toBe(true);
    recall.click();
    await flush();
    await sleep(50);
    expect(booted.store.memViewPageBase()).toBe(0);
    expect(sec.querySelector(".watch-recall-btn")).toBeNull();
  });

  it("recall button: appears after scrolling the watch row off the viewport", async () => {
    const sec = memorySection();
    const grid = memoryGrid();
    expect(sec.querySelector(".watch-recall-btn")).toBeNull();
    // Watch at 0 is at row index 0; scroll well past it.
    const rowH = Number.parseFloat(
      getComputedStyle(grid).getPropertyValue("--hex-row-h").trim(),
    );
    grid.scrollTop = 200 * rowH;
    grid.dispatchEvent(new Event("scroll"));
    // rAF coalesces — wait a couple of frames for the visibility
    // effect to fire.
    await sleep(80);
    expect(sec.querySelector(".watch-recall-btn")).not.toBeNull();
  });
});
