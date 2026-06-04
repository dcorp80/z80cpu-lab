// Pure glyph-renderer helpers for HW-trace signal rows. Extracted from
// the section component so the truncation + carry-forward semantics are
// unit-testable without mounting any Solid tree.
//
// Strict invariant: **one monospace cell = one HC** (REQ §6.4 / DESIGN
// §6.4). No expansion at transitions, no separators, no per-edge extra
// cells. A window of N HCs renders exactly N glyph cells per row. Bus
// value widths (4 chars for addr, 2 for data) consume their native
// width starting at the change HC; if the next transition arrives
// before the value finishes its width, the later value's leftmost cell
// overwrites the previous value's trailing cell — partial values are
// accepted in exchange for the strict 1-cell-per-HC rule.
//
// All glyphs come from `STR.hwTrace.glyphs` (per REQ §7.1 — single
// restyle surface). Callers pass them in so this module stays free of
// any string-table import; it just consumes constants.

import type { Tri } from "../../runloop/hwTrace.ts";

/**
 * Glyph set the renderers consume. Matches `STR.hwTrace.glyphs` — the
 * section component is the only sane caller, and it passes the table
 * straight through. Keeping the dependency at the call site (not the
 * module) means tests can verify behavior with stub glyphs.
 */
export interface HwTraceGlyphs {
  /** Top-rail glyph for 1-bit signals at high level. */
  high: string;
  /** Bottom-rail glyph for 1-bit signals at low level. */
  low: string;
  /** Mid-rail dashed glyph for tristate (1-bit `Z` and bus-value floating). */
  tristate: string;
  /** Filler glyph for the held span of a bus value between transitions. */
  busHoldFiller: string;
}

/**
 * Discrete transition for a 1-bit row. `hc` is absolute; the renderer
 * trims to the window itself.
 */
export interface BitTransition {
  hc: number;
  value: 0 | 1;
}

export interface TriTransition {
  hc: number;
  value: Tri;
}

export interface BusValueTransition {
  hc: number;
  /** `undefined` ⇒ tristate at this edge. */
  value: number | undefined;
}

/**
 * Render a 1-bit signal row across `[windowLo, windowHi]` (inclusive on
 * both ends). Returns one glyph per HC, joined into a single string.
 * `transitions` must be sorted by `hc` ascending and trimmed to the
 * window OR the renderer's surrounding context (transitions outside
 * the window are tolerated but ignored).
 *
 * `initialValue` is the level at `windowLo` BEFORE any in-window
 * transition fires. For now the section passes `1` (deasserted high) —
 * proper carry-forward from before the window is an M8a follow-up
 * tracked separately.
 */
export function renderBitRow(
  transitions: ReadonlyArray<BitTransition>,
  windowLo: number,
  windowHi: number,
  initialValue: 0 | 1,
  glyphs: HwTraceGlyphs,
): string {
  // Glyph form of `bitLevelRow` — one shared walk, mapped to rails — so
  // the level semantics (carry-forward, drop-at-transition-HC) live in
  // exactly one place. `bitLevelRow` returns `[]` for an empty window,
  // which `.join("")` collapses to "".
  return bitLevelRow(transitions, windowLo, windowHi, initialValue)
    .map((v) => (v === 1 ? glyphs.high : glyphs.low))
    .join("");
}

/**
 * Per-cell levels of a 1-bit signal across `[windowLo, windowHi]`: the
 * walk primitive that `renderBitRow` maps to rail glyphs, exposed in raw
 * `0|1` form so one row can style itself per-cell against ANOTHER signal.
 * The `addr` row dims cells where `nRFSH` is low (DRAM refresh) so refresh
 * addresses read distinctly from operational ones. The dim decision keys
 * purely on `nRFSH` level, never on whether `addr` changed — a refresh
 * address can coincidentally equal the preceding operational address and
 * must still be marked.
 */
export function bitLevelRow(
  transitions: ReadonlyArray<BitTransition>,
  windowLo: number,
  windowHi: number,
  initialValue: 0 | 1,
): (0 | 1)[] {
  if (windowHi < windowLo) return [];
  const len = windowHi - windowLo + 1;
  const out = new Array<0 | 1>(len);
  let cur: 0 | 1 = initialValue;
  let txIdx = 0;
  for (let i = 0; i < len; i++) {
    const hc = windowLo + i;
    while (txIdx < transitions.length && transitions[txIdx].hc <= hc) {
      cur = transitions[txIdx].value;
      txIdx++;
    }
    out[i] = cur;
  }
  return out;
}

/**
 * Same as `renderBitRow` but accepts `Tri` values (0|1|2). Tristate
 * (`2`) renders as the mid-rail dashed glyph.
 */
export function renderTriRow(
  transitions: ReadonlyArray<TriTransition>,
  windowLo: number,
  windowHi: number,
  initialValue: Tri,
  glyphs: HwTraceGlyphs,
): string {
  if (windowHi < windowLo) return "";
  const len = windowHi - windowLo + 1;
  const cells = new Array<string>(len);
  let cur: Tri = initialValue;
  let txIdx = 0;
  for (let i = 0; i < len; i++) {
    const hc = windowLo + i;
    while (txIdx < transitions.length && transitions[txIdx].hc <= hc) {
      cur = transitions[txIdx].value;
      txIdx++;
    }
    cells[i] =
      cur === 0 ? glyphs.low : cur === 1 ? glyphs.high : glyphs.tristate;
  }
  return cells.join("");
}

/**
 * Render a bus-value row (`addr` width 4, `data` width 2). At each
 * transition `hc`, the renderer paints `width` hex chars starting at
 * that HC's cell; cells past the value's width hold `busHoldFiller`
 * until the next transition. Tristate values (`undefined`) paint
 * `width` `tristate` glyphs and the held span uses `tristate` as
 * filler so "value held" stays visually distinct from "value unknown."
 *
 * If a new transition arrives before the previous value's width
 * elapses, the new value's leftmost cell overwrites the old value's
 * trailing cell — see the file header for the rationale.
 *
 * `initialValue` is the bus value at `windowLo` BEFORE any in-window
 * transition. Pass `undefined` to render the pre-transition span as
 * tristate filler; pass a number to render it as bus-hold filler with
 * no visible chars (no transition = no chars).
 */
export function renderBusValueRow(
  transitions: ReadonlyArray<BusValueTransition>,
  windowLo: number,
  windowHi: number,
  width: number,
  initialValue: number | undefined,
  glyphs: HwTraceGlyphs,
): string {
  if (windowHi < windowLo) return "";
  const len = windowHi - windowLo + 1;
  const cells = new Array<string>(len);
  let currentValue: number | undefined = initialValue;
  let charPos = -1; // -1 = filler, 0..(width-1) = inside a fresh value's hex chars
  let currentHex = "";
  let txIdx = 0;
  for (let i = 0; i < len; i++) {
    const hc = windowLo + i;
    // Advance through any transitions that landed at this HC. A
    // transition that lands mid-render (inside the previous value's
    // hex chars) resets charPos — earlier chars stay on the row, later
    // chars never render. That's the documented truncation.
    while (txIdx < transitions.length && transitions[txIdx].hc <= hc) {
      currentValue = transitions[txIdx].value;
      if (transitions[txIdx].hc === hc) {
        charPos = 0;
        currentHex =
          currentValue === undefined
            ? ""
            : currentValue.toString(16).toUpperCase().padStart(width, "0");
      } else {
        // Transition before windowLo — leave us in filler mode at the
        // window boundary with the new currentValue carried in.
        charPos = -1;
        currentHex = "";
      }
      txIdx++;
    }
    if (charPos >= 0 && charPos < width) {
      cells[i] =
        currentValue === undefined ? glyphs.tristate : currentHex[charPos];
      charPos++;
    } else {
      cells[i] =
        currentValue === undefined ? glyphs.tristate : glyphs.busHoldFiller;
    }
  }
  return cells.join("");
}

/** A contiguous run of a rendered row sharing one styling state. */
export interface RowSegment {
  text: string;
  /** `true` ⇒ render dimmed (e.g. a DRAM-refresh address). */
  dim: boolean;
}

/**
 * Split a rendered row string into contiguous runs by a per-cell boolean
 * `mask` (`true` ⇒ dim this cell). Used to dim `addr` cells during DRAM
 * refresh without abandoning the one-string-per-row render: adjacent
 * cells with equal mask value coalesce, so the addr row costs O(refresh
 * toggles) spans, not O(cells). All HW-trace glyphs are single UTF-16
 * units, so `text[i]` indexes cell `i` directly.
 *
 * Cells past `mask.length` (or an empty mask) are treated as not dimmed —
 * a row with no refresh activity collapses to a single non-dim run.
 */
export function segmentByMask(
  text: string,
  mask: ReadonlyArray<boolean>,
): RowSegment[] {
  const len = text.length;
  if (len === 0) return [];
  const segs: RowSegment[] = [];
  let start = 0;
  let curDim = mask[0] === true;
  for (let i = 1; i < len; i++) {
    const dim = mask[i] === true;
    if (dim !== curDim) {
      segs.push({ text: text.slice(start, i), dim: curDim });
      start = i;
      curDim = dim;
    }
  }
  segs.push({ text: text.slice(start), dim: curDim });
  return segs;
}
