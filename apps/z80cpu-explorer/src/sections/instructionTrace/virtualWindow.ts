// Rows rendered beyond the visible viewport on each side. Smooths over
// fast scrolls so the user rarely sees a blank row enter the viewport.
export const VIRTUAL_OVERSCAN_ROWS = 20;

// Fallback window size used when viewportH is 0 (happy-dom unit tests,
// or any environment without real layout). Large enough that
// presence-of-row assertions still pass; small enough not to defeat
// virtualization if accidentally taken in a real layout.
export const VIRTUAL_FALLBACK_ROWS = 50;

// Default rowH if the CSS custom property is missing or unparseable.
// Must stay aligned with the `--itrace-row-h` default in styles.css.
export const VIRTUAL_DEFAULT_ROW_H_PX = 20;

// Defensive ceiling for the virtualization spacer's pixel height.
// Chrome's max element size is ~33.5 M px; past that the element gets
// silently clipped and the scrollbar position desyncs from the window
// math. Sized to leave headroom under that limit (≈ 1.6 M rows × 20 px).
export const VIRTUAL_SPACER_MAX_PX = 32_000_000;

export interface VirtualWindow {
  /** Inclusive lower index. */
  first: number;
  /** Exclusive upper index. */
  last: number;
}

/**
 * Map a scroll position + viewport to the inclusive-exclusive
 * `[first, last)` index range to render.
 *
 * Edge cases:
 * - Empty source (`total <= 0`) → `{0, 0}`.
 * - Unmeasured viewport (`viewportH <= 0` or `rowH <= 0`) → first
 *   `VIRTUAL_FALLBACK_ROWS` rows (the happy-dom fallback — keeps unit
 *   tests that assert row presence working without real layout).
 */
export function computeVirtualWindow(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan: number = VIRTUAL_OVERSCAN_ROWS,
): VirtualWindow {
  if (total <= 0) return { first: 0, last: 0 };
  if (viewportH <= 0 || rowH <= 0) {
    return { first: 0, last: Math.min(total, VIRTUAL_FALLBACK_ROWS) };
  }
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const last = Math.min(
    total,
    Math.ceil((scrollTop + viewportH) / rowH) + overscan,
  );
  return { first, last };
}
