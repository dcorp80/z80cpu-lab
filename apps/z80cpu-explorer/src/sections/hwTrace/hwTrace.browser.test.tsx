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

import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { type BootedApp, bootApp } from "../../boot.tsx";
import { STR } from "../../style/strings.ts";
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

  it("draws M1 gridlines whose origin lands on the waveform's first cell", async () => {
    const runBtn = page.getByRole("button", { name: "Run" });
    await runBtn.click();
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && booted.store.hc() < 2000) {
      await sleep(16);
    }
    await page.getByRole("button", { name: "Pause" }).click();
    await sleep(16);

    // RST 38h spin fetches an M1 every instruction → many nM1 falling
    // edges → many gridlines.
    const lines = document.querySelectorAll(".hwt-gridline");
    expect(lines.length).toBeGreaterThan(0);

    // The gridline layer's left origin must coincide with the waveform's
    // first cell (label-w + row-gap). If that offset ever drifts from the
    // real label geometry, the whole grid marches off the cells — so this
    // pins the CSS-var math to the laid-out result. Difference is taken so
    // horizontal scroll position cancels out.
    const layer = document.querySelector<HTMLElement>(".hwt-gridlines");
    const wave = document.querySelector<HTMLElement>(".hwt-row-waveform");
    expect(layer).not.toBeNull();
    expect(wave).not.toBeNull();
    if (!layer || !wave) return;
    expect(
      Math.abs(
        layer.getBoundingClientRect().left - wave.getBoundingClientRect().left,
      ),
    ).toBeLessThan(1.5);
  });
});

// The whole HW-trace layout rests on "1 glyph = 1 HC cell": rows are
// single joined strings (no per-cell box), so vertical alignment across
// rows holds only if EVERY glyph advances the same width as the hex
// digits used in bus rows. The original scan-line rails (⎺/⎽) rendered
// narrower than a cell in the bundled monospace font, so bus rows drifted
// ahead of oscilloscope rows by ~1 cell per few hundred HC. This guards
// against any future glyph swap reintroducing a sub-cell advance. Needs
// real paint metrics, so it lives in the browser tier (happy-dom fakes
// getBoundingClientRect width).
describe("HW trace glyph width invariant", () => {
  // Render `count` copies of `ch` inside the real glyph span (same
  // font-family/size + letter-spacing:0 as production) and return the
  // laid-out width. Measures the inner `.hwt-row-glyphs` element — it
  // is `display: inline-block` and sizes to its content, unlike the
  // outer `.hwt-row-waveform` spacer whose width is driven by the
  // `--hwt-cells` CSS var (horizontal virtualization).
  function measureWidth(ch: string, count: number): number {
    const body = document.createElement("div");
    body.className = "hwt-body";
    const row = document.createElement("div");
    row.className = "hwt-row";
    const waveform = document.createElement("span");
    waveform.className = "hwt-row-waveform";
    const glyphs = document.createElement("span");
    glyphs.className = "hwt-row-glyphs";
    glyphs.textContent = ch.repeat(count);
    waveform.append(glyphs);
    row.append(waveform);
    body.append(row);
    document.body.append(body);
    const w = glyphs.getBoundingClientRect().width;
    body.remove();
    return w;
  }

  it("every waveform glyph advances exactly one monospace cell", () => {
    // 300 cells = roughly the scale at which the old rails slipped a full
    // cell, so any residual sub-cell mismatch shows up amplified ×300.
    const N = 300;
    const ref = measureWidth("0", N); // hex digit = canonical 1ch
    expect(ref).toBeGreaterThan(0); // sanity: real layout happened
    for (const [name, ch] of Object.entries(STR.hwTrace.glyphs)) {
      const w = measureWidth(ch, N);
      // Total drift across 300 cells must stay sub-pixel — i.e. the
      // per-cell advance is indistinguishable from the hex digit's.
      expect(Math.abs(w - ref), `glyph "${name}" (${ch})`).toBeLessThan(1);
    }
  });
});
