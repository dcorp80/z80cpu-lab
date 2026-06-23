// HW-trace section UI. Renders a logic-
// analyzer view of recent bus transitions: one row per signal, glyphs
// laid out at strict 1-cell-per-HC. Header carries the capture-mode
// toggle and (when the cursor is detached) the snap-to-live button.
//
// HC=0 is the pre-simulation point and is never recorded or rendered.
// The display window always starts at HC=1; the first visible cell is
// the bus state right after the first clockEdge.
//
// M8b status: input-signal rows (nINT/nNMI/nRESET/nBUSRQ/nWAIT) carry
// a checkbox in their left header column that drives the bus pin via
// `store.setInputPin`. The INT vector input moved to the new
// Interrupts section so the HW trace stays a pure
// logic-analyzer view. VCD export lands in M8c.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { InputPinName } from "../../runloop/bus.ts";
import {
  ALL_SIGNALS,
  BUS_VALUE_SIGNALS,
  type BusSnapshotRecord,
  type BusValueSignal,
  INPUT_BIT_SIGNALS,
  type InputBitSignal,
  OUTPUT_TRI_SIGNALS,
  type SignalName,
  type Tri,
  type TriSignal,
} from "../../runloop/hwTrace.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { parsePositiveInt } from "../../util/num.ts";
import {
  VIRTUAL_FALLBACK_ROWS,
  VIRTUAL_OVERSCAN_ROWS,
  VIRTUAL_SPACER_MAX_PX,
} from "../instructionTrace/virtualWindow.ts";
import type { SectionModule } from "../types.ts";
import {
  type BitTransition,
  type BusValueTransition,
  bitLevelRow,
  type RowSegment,
  renderBitRow,
  renderBusValueRow,
  renderTriRow,
  segmentByMask,
  type TriTransition,
} from "./render.ts";

const TRI_SET: ReadonlySet<string> = new Set(OUTPUT_TRI_SIGNALS);
const BUS_VALUE_SET: ReadonlySet<string> = new Set(BUS_VALUE_SIGNALS);
const INPUT_BIT_SET: ReadonlySet<string> = new Set(INPUT_BIT_SIGNALS);

const isTri = (name: SignalName): name is TriSignal => TRI_SET.has(name);
const isBusValue = (name: SignalName): name is BusValueSignal =>
  BUS_VALUE_SET.has(name);
const isInputBit = (name: SignalName): name is InputBitSignal =>
  INPUT_BIT_SET.has(name);

const Header: Component = () => {
  const store = useStore();
  // Step HC / Step N HC / Zero HC are paused-only (mirrors the
  // equivalent guards in hotkeys/defaults.ts).
  const [stepHcN, setStepHcN] = createSignal("1");
  const onStepHcN = () => {
    const n = parsePositiveInt(stepHcN());
    if (n !== null) store.stepHC(n);
  };
  // Returning the cursor itself when detached lets <Show> hand the
  // narrowed slice to its child — same pattern as the instruction
  // trace section's header. The snap button is detached-only; the
  // capture-mode toggle is always present.
  const detached = () => {
    const c = store.cursors.hwTrace;
    return c.mode === "detached" ? c : null;
  };
  return (
    <div class="hwt-header-controls">
      <button
        type="button"
        class="btn"
        onClick={() => store.stepHC(1)}
        disabled={!store.isPaused()}
        title={STR.hwTrace.stepHcTooltip}
      >
        {STR.hwTrace.stepHc}
      </button>
      <input
        class="step-n-input"
        type="text"
        inputmode="numeric"
        value={stepHcN()}
        onInput={(e) => setStepHcN(e.currentTarget.value)}
        aria-label={STR.hwTrace.stepHcCountLabel}
        size={6}
      />
      <button
        type="button"
        class="btn"
        onClick={onStepHcN}
        disabled={!store.isPaused()}
        title={STR.hwTrace.stepNHcTooltip}
      >
        {STR.hwTrace.stepNHc}
      </button>
      <button
        type="button"
        class="btn"
        onClick={() => store.zeroHC()}
        disabled={!store.isPaused()}
        title={STR.hwTrace.zeroHcTooltip}
      >
        {STR.hwTrace.zeroHc}
      </button>
      <label class="hwt-capture-mode" title={STR.hwTrace.captureToggleTooltip}>
        <input
          type="checkbox"
          aria-label={STR.hwTrace.captureToggleAriaLabel}
          checked={store.hwTraceCapture()}
          disabled={!store.isPaused()}
          onChange={(e) => store.setHwTraceCapture(e.currentTarget.checked)}
        />
        <span class="hwt-capture-mode-label">
          {STR.hwTrace.captureToggleLabel}
        </span>
      </label>
      <Show when={detached()}>
        {(c) => (
          <>
            <span
              class="hwt-detached-badge"
              title={STR.hwTrace.detachedBadgeTooltip(
                formatHex(c().anchorHc, 0),
              )}
            >
              {STR.hwTrace.detachedBadge}
            </span>
            <button
              type="button"
              class="btn hwt-snap"
              onClick={() => store.snapHwTraceCursorToLive()}
              title={STR.hwTrace.snapToLiveTooltip}
            >
              {STR.hwTrace.snapToLive}
            </button>
          </>
        )}
      </Show>
    </div>
  );
};

const FoldedSummary: Component = () => {
  const store = useStore();
  const summary = createMemo(() => {
    // Subscribe to the version signal so the summary refreshes when
    // new records land. The version advances at rAF
    // cadence (gated by `loop.onTick` in the store).
    store.hwTraceVersion();
    const capture = store.hwTraceCapture();
    const cursor = store.cursors.hwTrace;
    const viewing =
      cursor.mode === "live"
        ? STR.hwTrace.viewingLive
        : STR.hwTrace.viewingDetached(formatHex(cursor.anchorHc, 0));
    const newest = store.hwTrace.newestHc();
    if (newest === undefined) {
      return STR.hwTrace.foldedSummaryEmpty(capture, viewing);
    }
    return STR.hwTrace.foldedSummaryWithLast(
      formatHex(newest, 0),
      capture,
      viewing,
    );
  });
  return <span class="hwt-folded-summary">{summary()}</span>;
};

/** Pre-extracted per-signal data for one render of the body. */
interface RowData {
  /** Carry-forward value at `windowLo` — used as `initialValue`. */
  initialBit: 0 | 1;
  initialTri: Tri;
  initialBus: number | undefined;
  /** In-window transitions for THIS signal, HC-ascending. */
  bit: BitTransition[];
  tri: TriTransition[];
  bus: BusValueTransition[];
}

/**
 * Per-signal row component — one per signal. Isolation preps for post-MVP
 * drag-to-reorder of rows and keeps render cost per signal flat.
 *
 * M8b: input-signal rows (nINT/nNMI/nRESET/nBUSRQ/nWAIT) carry a small
 * checkbox in the left header. Checked = asserted (level 0, active-low);
 * unchecked = deasserted (level 1). nNMI is special: the bus auto-clears
 * it after one HC to render as a 1-HC pulse in the trace
 * ([[feedback-nmi-pulse-semantics]]) — the checkbox visually returns to
 * unchecked on the next tick.
 */
const InputPinCheckbox: Component<{ signal: InputBitSignal }> = (props) => {
  const store = useStore();
  const name: InputPinName = props.signal;
  const checked = () => store.inputPins[name] === 0;
  // Paused-only to match every other write through the bus (memory/IO
  // edits, INT vector). Disables during run AND step — a single-step
  // checkbox change wouldn't take effect until the next paused state
  // anyway, and the consistent `!isPaused()` gate keeps the UX uniform.
  // nINT is disabled when the INT generator owns the pin so the user
  // can't silently disturb the generator's schedule. The tooltip explains
  // why the control is greyed (STR.interrupts.genNIntDisabledTooltip).
  const genOwnsNInt = () => name === "nINT" && store.intGen().enabled;
  const isDisabled = () => !store.isPaused() || genOwnsNInt();
  const title = () =>
    genOwnsNInt()
      ? STR.interrupts.genNIntDisabledTooltip
      : STR.hwTrace.inputPinTooltip(props.signal);

  return (
    <input
      type="checkbox"
      class="hwt-input-checkbox"
      aria-label={STR.hwTrace.inputPinAriaLabel(props.signal)}
      title={title()}
      checked={checked()}
      disabled={isDisabled()}
      onChange={(e) => store.setInputPin(name, e.currentTarget.checked ? 0 : 1)}
    />
  );
};

const SignalRow: Component<{
  signal: SignalName;
  /**
   * HC bounds of the cells this row should render. The waveform spacer
   * sits in the wider `[renderBounds.lo, renderBounds.hi]` span (driven
   * by `--hwt-cells` on `.hwt-content`); the inner glyph node renders
   * only `[emitLo, emitHi]` and translates into place via `--hwt-first`.
   */
  emitLo: number;
  emitHi: number;
  row: RowData;
  /**
   * Optional per-cell dim mask (true ⇒ render that cell dimmed). Only the
   * `addr` row passes one — it marks DRAM-refresh cells (nRFSH low) so
   * refresh addresses read distinctly from operational ones. Length must
   * match the emit window (`emitHi - emitLo + 1`).
   */
  dimMask?: ReadonlyArray<boolean>;
}> = (props) => {
  const glyphs = STR.hwTrace.glyphs;
  // Each row renders as one or more runs. Rows without a dim mask collapse
  // to a single full-width run, preserving the one-node-per-row cost; the
  // addr row splits into dim/normal runs at refresh boundaries.
  const segments = createMemo<RowSegment[]>(() => {
    let text: string;
    if (isBusValue(props.signal)) {
      const width = props.signal === "addr" ? 4 : 2;
      text = renderBusValueRow(
        props.row.bus,
        props.emitLo,
        props.emitHi,
        width,
        props.row.initialBus,
        glyphs,
      );
      const mask = props.dimMask;
      if (mask?.length) return segmentByMask(text, mask);
    } else if (isTri(props.signal)) {
      text = renderTriRow(
        props.row.tri,
        props.emitLo,
        props.emitHi,
        props.row.initialTri,
        glyphs,
      );
    } else {
      text = renderBitRow(
        props.row.bit,
        props.emitLo,
        props.emitHi,
        props.row.initialBit,
        glyphs,
      );
    }
    return [{ text, dim: false }];
  });
  return (
    <div class="hwt-row">
      <span class="hwt-row-label">
        <span class="hwt-row-label-text">
          {STR.hwTrace.signalLabels[props.signal]}
        </span>
        <Show when={isInputBit(props.signal)}>
          <InputPinCheckbox signal={props.signal as InputBitSignal} />
        </Show>
      </span>
      <span class="hwt-row-waveform">
        <span class="hwt-row-glyphs">
          <For each={segments()}>
            {(seg) =>
              seg.dim ? (
                <span class="hwt-bus-refresh">{seg.text}</span>
              ) : (
                seg.text
              )
            }
          </For>
        </span>
      </span>
    </div>
  );
};

/** All-signals row map with default (deasserted/empty) carry-forward. */
function emptyRowData(): Record<SignalName, RowData> {
  const empty = (): RowData => ({
    initialBit: 1,
    initialTri: 1,
    initialBus: undefined,
    bit: [],
    tri: [],
    bus: [],
  });
  const out: Partial<Record<SignalName, RowData>> = {};
  for (const name of ALL_SIGNALS) out[name] = empty();
  return out as Record<SignalName, RowData>;
}

/**
 * Build per-signal carry-forward levels + in-window transition lists in a
 * single walk over the window, regardless of signal count.
 *
 * `seed` is the snapshot immediately before `windowLo` (from
 * `buffer.latestBefore`). Because every snapshot is a FULL bus state, that
 * one record seeds the level of every signal at the left edge — no need to
 * re-walk (and allocate) the whole pre-window history. `seed === undefined`
 * means nothing older exists, so levels stay at their defaults.
 *
 * `windowSnapshots` are the snapshots in `[windowLo, windowHi]`. Note we do
 * NOT seed the dedup state from `seed`: the first in-window snapshot always
 * emits a transition (matching the renderer's "value appears at its change
 * HC" contract). Duplicates within the window are filtered so the renderer
 * only sees actual changes.
 */
function buildRowData(
  seed: BusSnapshotRecord | undefined,
  windowSnapshots: Iterable<BusSnapshotRecord>,
): Record<SignalName, RowData> {
  const out = emptyRowData();
  if (seed) {
    for (const name of ALL_SIGNALS) {
      const row = out[name];
      if (isBusValue(name)) row.initialBus = seed[name];
      else if (isTri(name)) row.initialTri = seed[name] as Tri;
      else row.initialBit = seed[name] as 0 | 1;
    }
  }
  // Per-signal last emitted value — used to filter duplicates from the
  // dense per-position snapshot stream. A Set marks "ever emitted"
  // since bus values are `number | undefined` and we'd otherwise
  // conflate "no emission yet" with "last emission was undefined."
  const lastEmittedBit: Partial<Record<SignalName, 0 | 1>> = {};
  const lastEmittedTri: Partial<Record<SignalName, Tri>> = {};
  const lastEmittedBus: Partial<Record<SignalName, number | undefined>> = {};
  const busEmitted = new Set<SignalName>();
  for (const snap of windowSnapshots) {
    for (const name of ALL_SIGNALS) {
      const row = out[name];
      if (isBusValue(name)) {
        const v = snap[name];
        if (busEmitted.has(name) && lastEmittedBus[name] === v) continue;
        row.bus.push({ hc: snap.hc, value: v });
        lastEmittedBus[name] = v;
        busEmitted.add(name);
      } else if (isTri(name)) {
        const v = snap[name] as Tri;
        if (lastEmittedTri[name] === v) continue;
        row.tri.push({ hc: snap.hc, value: v });
        lastEmittedTri[name] = v;
      } else {
        const v = snap[name] as 0 | 1;
        if (lastEmittedBit[name] === v) continue;
        row.bit.push({ hc: snap.hc, value: v });
        lastEmittedBit[name] = v;
      }
    }
  }
  return out;
}

/**
 * Scroll-edge detection epsilon (px). Browsers sometimes report a
 * fractional `scrollLeft` at the true edge (sub-pixel rounding); a
 * small slack avoids spuriously detaching on a perfectly-pinned view.
 */
const SCROLL_PIN_EPSILON_PX = 4;

// Conservative px-per-cell for the `renderBounds` spacer clamp. Slight
// overestimate of a typical 12 px monospace `1ch` (~7.2 px) so the
// resulting `maxFittingCells` underestimates, keeping the rendered
// spacer comfortably below `VIRTUAL_SPACER_MAX_PX`. Safe across browser
// zoom: page zoom doesn't change font-size in CSS px, so 1ch stays put
// in the same unit space getBCR / scrollWidth report in. We deliberately
// do NOT use a measured pitch here — feeding the spacer's own width
// back into the clamp couples renderBounds to contentW and adds a
// reactive cycle that has no payoff over the constant. Virtualization
// itself still uses contentW — see the math below.
const FALLBACK_CELL_PX = 8;

const Body: Component = () => {
  const store = useStore();
  let scrollEl: HTMLDivElement | undefined;
  // `contentEl` is a SIGNAL, not a let-binding: Solid's `<Show>` unmounts
  // the spacer when capture is toggled off and mounts a fresh node when
  // it goes back on, so a let-bound ref would leave the ResizeObserver
  // attached to the detached old node forever. Tracking via a signal
  // lets the RO-binding effect below re-run and rebind on each remount.
  const [contentEl, setContentEl] = createSignal<HTMLDivElement | undefined>(
    undefined,
  );

  // Horizontal virtualization signals — all in DOM pixels, all sourced
  // from the same browser-reported layout values:
  //   `scrollLeft` ← onScroll
  //   `viewportW`  ← ResizeObserver on the scroll element (clientWidth)
  //   `contentW`   ← ResizeObserver on the spacer (.hwt-content) PLUS a
  //                  synchronous re-read in the auto-pin effect to avoid
  //                  one frame of stale data immediately after pause.
  //
  // Critically we do NOT keep a separately-measured cell-pitch (e.g.
  // getBCR of an "M" or a `width: 1ch` probe span). The browser's own
  // resolution of `1ch` accumulates a sub-pixel rounding error across
  // `totalCells * 1ch`; if JS measures `1ch` even fractionally
  // differently, then `floor(scrollLeft / cellW)` drifts off the cell
  // grid and — at the right edge, where `last` is already capped at
  // `total` — the emit window collapses to the rightmost few cells.
  // Using `scrollLeft / contentW` as a fraction of `total` keeps JS
  // perfectly aligned with whatever pitch CSS actually rendered.
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewportW, setViewportW] = createSignal(0);
  const [contentW, setContentW] = createSignal(0);

  // Render extent = the full reachable HC range = `[max(1, oldestHc), hc]`.
  // No HC cap: horizontal virtualization (`virtualWindow` below) means
  // only the visible cells + overscan are mounted regardless of total HC
  // span, so the renderable range can equal the buffer's natural range.
  // The only backstop is Chrome's max element width — when the spacer
  // would exceed `VIRTUAL_SPACER_MAX_PX`, the left edge is pulled in so
  // the scroll position stays in sync with the cell math.
  //
  // The body renders ONLY while stopped: during a run these memos return
  // their previous value untouched (they don't track `hc`/version while
  // running), so the buffer walk happens once per pause, not per frame.
  // A future "live mode" would lift this gate — and would also need the
  // detached cursor to anchor render bounds, since a sliding window
  // can't hold a pinned HC while data grows.
  const renderBounds = createMemo<{ lo: number; hi: number }>(
    (prev) => {
      if (store.status() !== "paused") return prev;
      store.hwTraceVersion();
      const hi = store.hc();
      if (hi < 1) return { lo: 1, hi: 0 };
      // Empty ring → collapse to an empty window (hi<lo) so every row's
      // waveform renders as "" rather than filling the [1, hc] span with
      // carry-forward default levels. Rows still render (M8b: input-pin
      // checkboxes must stay reachable pre-step) — this only zeros the
      // emit range until something has actually been captured.
      const oldest = store.hwTrace.oldestHc();
      if (oldest === undefined) return { lo: 1, hi: 0 };
      // Clamp the left edge UP to the oldest recorded HC. `store.hc()` is
      // a free-running counter that keeps advancing while capture is
      // DISABLED, but the ring records nothing then — so an `hc`-anchored
      // left edge can fall before the first record and the renderer would
      // fill `[lo, oldestHc)` with default-deasserted carry-forward (the
      // "dead lines" bug). Pinning `lo` to `oldestHc()` keeps the window
      // over real data.
      let lo = Math.max(1, oldest);
      // Backstop the spacer against Chrome's ~33.5 Mpx element-width
      // limit: a spacer wider than that gets silently clipped and the
      // scrollbar desyncs from the cell math. Uses `FALLBACK_CELL_PX`
      // as a conservative overestimate of `1ch` — see the constant's
      // comment for why a measured pitch isn't used here.
      const maxFittingCells = Math.floor(
        VIRTUAL_SPACER_MAX_PX / FALLBACK_CELL_PX,
      );
      const minLo = hi - maxFittingCells + 1;
      if (lo < minLo) lo = minLo;
      return { lo, hi };
    },
    { lo: 1, hi: 0 },
  );

  const rowData = createMemo<Record<SignalName, RowData>>((prev) => {
    if (store.status() !== "paused") return prev;
    store.hwTraceVersion();
    const { lo, hi } = renderBounds();
    if (hi < 1) return emptyRowData();
    // Seed carry-forward from the single snapshot before the window
    // (`latestBefore`), then stream only the in-window range — avoids
    // allocating a record per pre-window snapshot on every render.
    return buildRowData(
      store.hwTrace.latestBefore(lo),
      store.hwTrace.rangeView(lo, hi),
    );
  }, emptyRowData());

  // Total cell count in the rendered HC range. Drives the spacer width
  // (`width: calc(--hwt-cells * 1ch)`) so the scrollbar represents the
  // full virtual range even though only a viewport's worth is mounted.
  const totalCells = createMemo<number>(() => {
    const { lo, hi } = renderBounds();
    return Math.max(0, hi - lo + 1);
  });

  // Map (scrollLeft, viewportW, contentW) onto the inclusive-exclusive
  // cell index range to mount. Uses `scrollLeft / contentW` as a fraction
  // of `total` rather than a JS-measured cell pitch — so the result is
  // *exactly* aligned with the cell positions CSS renders at, by
  // construction, with no accumulated rounding error.
  //
  // `equals` suppresses re-execution on sub-cell scrolls: every scroll
  // event sets scrollLeft, but the window only shifts when the floor /
  // ceil result actually changes.
  const virtualWindow = createMemo(
    () => {
      const total = totalCells();
      if (total <= 0) return { first: 0, last: 0 };
      const sw = contentW();
      const vw = viewportW();
      if (sw <= 0 || vw <= 0) {
        return { first: 0, last: Math.min(total, VIRTUAL_FALLBACK_ROWS) };
      }
      const sl = scrollLeft();
      const startFrac = Math.max(0, Math.min(1, sl / sw));
      const endFrac = Math.max(0, Math.min(1, (sl + vw) / sw));
      const first = Math.max(
        0,
        Math.floor(startFrac * total) - VIRTUAL_OVERSCAN_ROWS,
      );
      const last = Math.min(
        total,
        Math.ceil(endFrac * total) + VIRTUAL_OVERSCAN_ROWS,
      );
      return { first, last };
    },
    undefined,
    { equals: (a, b) => a.first === b.first && a.last === b.last },
  );

  // Emit window in HC terms — what each row renderer paints, sliced from
  // the full `rowData` transition lists. Walks transitions whose
  // `hc < emitLo` silently into the carry-forward; nothing past `emitHi`
  // is touched. Cost per row ≈ O(transitions_before_emit) + O(viewport).
  const emitBounds = createMemo<{ lo: number; hi: number }>(() => {
    const { lo, hi } = renderBounds();
    if (hi < lo) return { lo: 1, hi: 0 };
    const { first, last } = virtualWindow();
    if (last <= first) return { lo: 1, hi: 0 };
    return { lo: lo + first, hi: lo + last - 1 };
  });

  // M1-cycle start markers: cell offsets (relative to renderBounds.lo)
  // of every nM1 falling edge (1→0). Rendered as faint vertical rules so
  // instruction boundaries are visible at a glance — and as an alignment
  // ruler: lines + glyphs share the same 1ch grid, so any row drifted
  // off-grid would show its glyphs sliced mid-cell. Walking with the
  // carried-in level (`initialBit`) avoids marking a spurious edge when
  // the window opens mid-M1.
  //
  // Filtered to the virtual window (with overscan baked into `first`/
  // `last` already) so only on-screen gridline divs get mounted.
  const m1Starts = createMemo<number[]>(() => {
    const { lo } = renderBounds();
    const { first, last } = virtualWindow();
    if (last <= first) return [];
    const row = rowData().nM1;
    if (!row) return [];
    const transitions = row.bit;
    // Binary-search for the first transition with `offset >= first` so a
    // capacity-many nM1 transition list doesn't pay O(N) per scroll
    // boundary. The carry-forward `prev` at the cut point is the
    // previous transition's value, or `initialBit` if none exists.
    let bsLo = 0;
    let bsHi = transitions.length;
    while (bsLo < bsHi) {
      const mid = (bsLo + bsHi) >>> 1;
      if (transitions[mid].hc - lo < first) bsLo = mid + 1;
      else bsHi = mid;
    }
    let prev: 0 | 1 = bsLo === 0 ? row.initialBit : transitions[bsLo - 1].value;
    const offsets: number[] = [];
    for (let i = bsLo; i < transitions.length; i++) {
      const t = transitions[i];
      const offset = t.hc - lo;
      if (offset >= last) break;
      if (prev === 1 && t.value === 0) offsets.push(offset);
      prev = t.value;
    }
    return offsets;
  });

  // Per-cell DRAM-refresh mask for the EMIT window only (length matches
  // the rendered addr-row string, not the full HC span). Keyed on nRFSH
  // level — never on whether addr changed, since a refresh address can
  // coincidentally equal the prior operational one.
  const refreshMask = createMemo<boolean[]>(() => {
    const { lo, hi } = emitBounds();
    const row = rowData().nRFSH;
    if (!row || hi < lo) return [];
    return bitLevelRow(row.bit, lo, hi, row.initialBit).map((v) => v === 0);
  });

  // Scroll-driven cursor management + virtualization signal feed. When
  // the user scrolls left, detach the cursor at the rightmost visible
  // HC; when they scroll back to the right edge, snap to live. Mirrors
  // the instruction-trace section's scroll-bottom semantics, rotated 90°.
  const onScroll = (): void => {
    if (!scrollEl) return;
    setScrollLeft(scrollEl.scrollLeft);
    const { lo, hi } = renderBounds();
    if (hi < lo) return;
    // Use the spacer's fractional `contentW` as the proportion
    // denominator — same source virtualWindow uses, so the rightmost-
    // visible HC computed here matches the rightmost cell virtualWindow
    // is mounting. `scrollEl.scrollWidth` is rounded to an integer and
    // can disagree at the sub-pixel scale × millions-of-cells span.
    const sw = contentW() || scrollEl.scrollWidth;
    const atRight =
      sw - scrollEl.scrollLeft - scrollEl.clientWidth < SCROLL_PIN_EPSILON_PX;
    const cursor = store.cursors.hwTrace;
    if (atRight) {
      if (cursor.mode === "detached") store.snapHwTraceCursorToLive();
      return;
    }
    // Compute rightmost visible HC from scroll position. `sw` covers
    // exactly `(hi - lo + 1)` cells, so the cell-width factor cancels
    // out in the proportion.
    const cells = hi - lo + 1;
    const rightPx = scrollEl.scrollLeft + scrollEl.clientWidth;
    const rightProp = Math.min(1, Math.max(0, rightPx / sw));
    const rightmostHc = Math.min(
      hi,
      Math.max(lo, lo + Math.floor(rightProp * cells) - 1),
    );
    if (cursor.mode === "live") {
      store.detachHwTraceCursor(rightmostHc);
    } else if (cursor.anchorHc !== rightmostHc) {
      store.detachHwTraceCursor(rightmostHc);
    }
  };

  const setScrollRef = (el: HTMLDivElement) => {
    scrollEl = el;
  };
  const setContentRef = (el: HTMLDivElement) => {
    setContentEl(el);
  };
  onMount(() => {
    if (!scrollEl) return;
    setViewportW(scrollEl.clientWidth);
    setScrollLeft(scrollEl.scrollLeft);
    const ro = new ResizeObserver(() => {
      if (scrollEl) setViewportW(scrollEl.clientWidth);
    });
    ro.observe(scrollEl);
    onCleanup(() => ro.disconnect());
  });

  // Re-bind a fresh ResizeObserver every time the spacer node changes.
  // Solid's `<Show>` unmounts the spacer when capture is toggled off
  // and mounts a new node when it goes back on; without re-binding,
  // the original RO keeps observing the detached old node and `contentW`
  // never updates after the first toggle (or — if capture started off
  // — never gets measured at all). The spacer's width = totalCells *
  // resolved `1ch`, so its resize ticks also catch browser-zoom shifts.
  createEffect(() => {
    const el = contentEl();
    if (!el) return;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setContentW(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // Auto-pin scroll to right edge when the cursor is live. Re-fires
  // whenever data grows (version bump) or the cursor flips live (e.g.,
  // snap-to-live click / `g` hotkey). Sync-reads spacer width + viewport
  // and updates the reactive signals FIRST so virtualWindow / emitBounds
  // recompute against the just-rendered spacer (without this the RO is
  // one frame behind the version bump and the first paint after pause
  // computes its window against the OLD contentW).
  createEffect(() => {
    store.hwTraceVersion();
    const mode = store.cursors.hwTrace.mode;
    if (store.status() !== "paused") return;
    queueMicrotask(() => {
      if (!scrollEl) return;
      if (mode !== "live") return;
      const el = contentEl();
      const sw = el ? el.getBoundingClientRect().width : scrollEl.scrollWidth;
      const cw = scrollEl.clientWidth;
      setContentW(sw);
      setViewportW(cw);
      const newLeft = Math.max(0, sw - cw);
      setScrollLeft(newLeft);
      scrollEl.scrollLeft = newLeft;
    });
  });

  return (
    <div class="hwt-body" ref={setScrollRef} onScroll={onScroll}>
      {/* Capture ON: rows render even when the ring is empty so the
          user can assert input pins before the first edge.
          Capture OFF: hide the row column entirely — there's nothing to
          assert toward, and the muted status line carries the message
          on its own. */}
      <Show when={!store.hwTraceCapture()}>
        <span class="hwt-body-status muted">{STR.hwTrace.bodyDisabled}</span>
      </Show>
      <Show when={store.hwTraceCapture()}>
        <div
          class="hwt-content"
          ref={setContentRef}
          style={{
            // Inherited by .hwt-row-waveform (spacer width) and
            // .hwt-row-glyphs (translateX offset) so each row doesn't
            // need its own inline style.
            "--hwt-cells": String(totalCells()),
            "--hwt-first": String(virtualWindow().first),
          }}
        >
          <div class="hwt-gridlines" aria-hidden="true">
            <For each={m1Starts()}>
              {(offset) => (
                <div
                  class="hwt-gridline"
                  style={{ left: `calc(${offset} * 1ch)` }}
                />
              )}
            </For>
          </div>
          <For each={ALL_SIGNALS}>
            {(name) => (
              <SignalRow
                signal={name}
                emitLo={emitBounds().lo}
                emitHi={emitBounds().hi}
                row={rowData()[name]}
                dimMask={name === "addr" ? refreshMask() : undefined}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export const hwTrace: SectionModule = {
  id: "hwTrace",
  title: STR.hwTrace.title,
  Header,
  FoldedSummary,
  Body,
};
