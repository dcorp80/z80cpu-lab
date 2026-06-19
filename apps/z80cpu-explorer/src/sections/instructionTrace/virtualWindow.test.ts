import { describe, expect, it } from "vitest";
import {
  computeVirtualWindow,
  VIRTUAL_FALLBACK_ROWS,
  VIRTUAL_OVERSCAN_ROWS,
} from "./virtualWindow.ts";

describe("computeVirtualWindow", () => {
  it("returns {0,0} for an empty source", () => {
    expect(computeVirtualWindow(0, 240, 20, 0)).toEqual({ first: 0, last: 0 });
    // Negative total is treated the same as empty (defensive).
    expect(computeVirtualWindow(0, 240, 20, -1)).toEqual({ first: 0, last: 0 });
  });

  it("falls back to the first VIRTUAL_FALLBACK_ROWS when viewportH is 0", () => {
    // Happy-dom case: no real layout, clientHeight === 0.
    expect(computeVirtualWindow(0, 0, 20, 1000)).toEqual({
      first: 0,
      last: VIRTUAL_FALLBACK_ROWS,
    });
    // Same fallback when scrollTop is non-zero — we can't know which
    // window to render without a viewport, so always start at 0.
    expect(computeVirtualWindow(9999, 0, 20, 1000)).toEqual({
      first: 0,
      last: VIRTUAL_FALLBACK_ROWS,
    });
  });

  it("caps the fallback at total when total < VIRTUAL_FALLBACK_ROWS", () => {
    expect(computeVirtualWindow(0, 0, 20, 7)).toEqual({ first: 0, last: 7 });
  });

  it("falls back when rowH is 0 (defensive — CSS var missing)", () => {
    expect(computeVirtualWindow(0, 240, 0, 1000)).toEqual({
      first: 0,
      last: VIRTUAL_FALLBACK_ROWS,
    });
  });

  it("computes a centered window around scrollTop with overscan", () => {
    // viewportH=240, rowH=20 → 12 visible rows. scrollTop=2000 → top
    // visible row index = 100, bottom = 112. With default overscan=20,
    // expect first=80, last=132.
    const w = computeVirtualWindow(2000, 240, 20, 1000);
    expect(w).toEqual({
      first: 100 - VIRTUAL_OVERSCAN_ROWS,
      last: 112 + VIRTUAL_OVERSCAN_ROWS,
    });
  });

  it("clamps first to 0 near the top", () => {
    // scrollTop = rowH × 5 = 100. floor(100/20)=5; overscan=20 → -15
    // clamped to 0.
    const w = computeVirtualWindow(100, 240, 20, 1000);
    expect(w.first).toBe(0);
    expect(w.last).toBe(Math.ceil((100 + 240) / 20) + VIRTUAL_OVERSCAN_ROWS);
  });

  it("clamps last to total near the bottom", () => {
    const total = 1000;
    // Scroll all the way down: viewportH=240, scrollTop=total*rowH-240
    // = 19760. Bottom visible row ≈ 1000; ceiling + overscan would
    // exceed total — clamp to total.
    const w = computeVirtualWindow(19760, 240, 20, total);
    expect(w.last).toBe(total);
    expect(w.first).toBeLessThan(total);
  });

  it("respects a custom overscan", () => {
    const w = computeVirtualWindow(2000, 240, 20, 1000, 5);
    expect(w).toEqual({ first: 95, last: 117 });
  });

  it("produces a slice ≤ viewportRows + 2×overscan + 1 in steady state", () => {
    // Sanity: the rendered window never grows without bound as scrollTop
    // moves through the middle of the source.
    const total = 100_000;
    const viewportH = 240;
    const rowH = 20;
    const visible = Math.ceil(viewportH / rowH); // 12
    const expectedMax = visible + 2 * VIRTUAL_OVERSCAN_ROWS + 1;
    for (let st = 0; st < total * rowH - viewportH; st += 1000) {
      const w = computeVirtualWindow(st, viewportH, rowH, total);
      expect(w.last - w.first).toBeLessThanOrEqual(expectedMax);
    }
  });
});
