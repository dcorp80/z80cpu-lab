// Browser-mode test for the instruction-trace section's scroll-detach
// behavior. Happy-dom doesn't honor scrollTop / scrollHeight / clientHeight
// fairly — element layout under jsdom-likes is a stub — so the cursor
// auto-detach on scroll is browser-tier territory.
//
// The unit tier covers the cursor verbs, snap-to-live button visibility,
// and the `g` hotkey; this layer adds the integration that needs real
// CSS layout: scroll up → detach + button appears, click snap → cursor
// re-attaches + scroll repins to bottom.

import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { type BootedApp, bootApp } from "../../boot.tsx";
import "../../styles.css";

let booted: BootedApp;
let dispose: () => void = () => {};

async function mountApp() {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  booted = await bootApp();
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

describe("Instruction trace (browser smoke)", () => {
  it("virtualizes the executed pane — row count bounded by viewport, not ring size", async () => {
    // Run long enough to push records well past the window
    // (~viewport rows + 2×overscan ≈ 52). 1 000 gives ~20× headroom
    // so `rowCount < 120` is a meaningful upper bound. Deadline is
    // generous so the test doesn't flake on loaded CI runners.
    const runBtn = page.getByRole("button", { name: "Run" });
    await runBtn.click();
    const targetInsns = 1_000;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && booted.store.insnCount() < targetInsns) {
      await sleep(16);
    }
    const pauseBtn = page.getByRole("button", { name: "Pause" });
    await pauseBtn.click();
    expect(booted.store.insnCount()).toBeGreaterThanOrEqual(targetInsns);
    expect(booted.store.traceRing.size()).toBeGreaterThanOrEqual(targetInsns);

    // Only the window's worth of rows are mounted, regardless of ring size.
    const scrollEl = document.querySelector<HTMLDivElement>(".itrace-executed");
    expect(scrollEl).not.toBeNull();
    if (!scrollEl) return;
    const rowCount = scrollEl.querySelectorAll(".itrace-row").length;
    // Generous upper bound — viewport rows + 2 × overscan (20) + a few
    // ticks of slack. Far below the ring size either way.
    expect(rowCount).toBeLessThan(120);
    expect(rowCount).toBeGreaterThan(0);

    // The spacer reserves the full virtual scrollHeight so the scrollbar
    // behaves as if every row were mounted.
    const spacer = scrollEl.querySelector<HTMLDivElement>(
      ".itrace-virt-spacer",
    );
    expect(spacer).not.toBeNull();
    if (!spacer) return;
    const ringSize = booted.store.traceRing.size();
    const rowH = Number.parseFloat(
      getComputedStyle(scrollEl).getPropertyValue("--itrace-row-h").trim(),
    );
    expect(rowH).toBeGreaterThan(0);
    expect(spacer.getBoundingClientRect().height).toBeCloseTo(
      ringSize * rowH,
      0,
    );
  });

  it("scroll-up detaches the cursor; snap-to-live repins to bottom", async () => {
    // Fill the ring with enough rows to make the executed log
    // scrollable. Default mem = 0xFF → RST 38h spins forever; ~200
    // insns lands in the first frame at full speed.
    const runBtn = page.getByRole("button", { name: "Run" });
    await runBtn.click();
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && booted.store.insnCount() < 200) {
      await sleep(16);
    }
    const pauseBtn = page.getByRole("button", { name: "Pause" });
    await pauseBtn.click();
    expect(booted.store.insnCount()).toBeGreaterThanOrEqual(200);

    // Cursor starts live; no snap button.
    expect(booted.store.cursors.instructionTrace.mode).toBe("live");
    expect(document.querySelector(".itrace-snap")).toBeNull();

    const scrollEl = document.querySelector<HTMLDivElement>(".itrace-executed");
    expect(scrollEl).not.toBeNull();
    if (!scrollEl) return;
    // Confirm layout produced a real scroll range (proving CSS is alive
    // and the unit-tier skip rationale holds — happy-dom returns 0 here).
    expect(scrollEl.scrollHeight).toBeGreaterThan(scrollEl.clientHeight);

    // Scroll up; the onScroll handler should detach.
    scrollEl.scrollTop = 0;
    scrollEl.dispatchEvent(new Event("scroll"));
    // Solid flushes synchronously; the next read sees the new mode.
    expect(booted.store.cursors.instructionTrace.mode).toBe("detached");
    expect(document.querySelector(".itrace-snap")).not.toBeNull();

    // Click snap-to-live; cursor returns to live and the auto-pin
    // effect scrolls the container back to bottom (via a microtask).
    (document.querySelector(".itrace-snap") as HTMLButtonElement).click();
    expect(booted.store.cursors.instructionTrace.mode).toBe("live");
    await sleep(16);
    expect(
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
    ).toBeLessThan(8);
  });
});
