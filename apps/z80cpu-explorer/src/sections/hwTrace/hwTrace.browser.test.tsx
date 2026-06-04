// Browser-mode test for the HW-trace section's scroll-detach behavior.
// Happy-dom doesn't honor scrollLeft / scrollWidth / clientWidth fairly —
// element layout under jsdom-likes is a stub — so the cursor auto-detach
// on horizontal scroll is browser-tier territory.
//
// The unit tier covers the cursor verbs, capture-mode toggle, snap-to-
// live button visibility, and glyph rendering against the buffer; this
// layer adds the integration that needs real CSS layout: scroll left →
// detach + button appears, click snap → cursor re-attaches + scroll
// repins to right edge.

import { page } from "@vitest/browser/context";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("HW trace (browser smoke)", () => {
  it("scroll-left detaches the cursor; snap-to-live repins to right edge", async () => {
    // Fill the buffer with enough HC range to make the waveform
    // scrollable. Default mem = 0xFF → RST 38h spins forever; a short
    // run accumulates plenty of bus activity.
    const runBtn = page.getByRole("button", { name: "Run" });
    await runBtn.click();
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && booted.store.hc() < 5000) {
      await sleep(16);
    }
    const pauseBtn = page.getByRole("button", { name: "Pause" });
    await pauseBtn.click();
    expect(booted.store.hc()).toBeGreaterThanOrEqual(5000);

    // Cursor starts live; no snap button, no detached badge.
    expect(booted.store.cursors.hwTrace.mode).toBe("live");
    expect(document.querySelector(".hwt-snap")).toBeNull();

    const scrollEl = document.querySelector<HTMLDivElement>(".hwt-body");
    expect(scrollEl).not.toBeNull();
    if (!scrollEl) return;
    // Confirm layout produced a real horizontal scroll range — proves the
    // unit-tier skip rationale holds (happy-dom returns 0 here).
    expect(scrollEl.scrollWidth).toBeGreaterThan(scrollEl.clientWidth);

    // The auto-pin effect runs on a microtask; let it settle so the
    // starting position is "right edge" rather than 0.
    await sleep(16);
    expect(
      scrollEl.scrollWidth - scrollEl.scrollLeft - scrollEl.clientWidth,
    ).toBeLessThan(8);

    // Scroll left; the onScroll handler should detach.
    scrollEl.scrollLeft = 0;
    scrollEl.dispatchEvent(new Event("scroll"));
    expect(booted.store.cursors.hwTrace.mode).toBe("detached");
    expect(document.querySelector(".hwt-snap")).not.toBeNull();

    // Click snap-to-live; cursor returns to live and the auto-pin effect
    // scrolls the container back to the right edge (via a microtask).
    (document.querySelector(".hwt-snap") as HTMLButtonElement).click();
    expect(booted.store.cursors.hwTrace.mode).toBe("live");
    await sleep(16);
    expect(
      scrollEl.scrollWidth - scrollEl.scrollLeft - scrollEl.clientWidth,
    ).toBeLessThan(8);
  });
});
