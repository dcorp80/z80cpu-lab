// HW-trace section UI (REQ §6.4 / DESIGN §6.4). Renders a logic-
// analyzer view of recent bus transitions: one row per signal, glyphs
// laid out at strict 1-cell-per-HC. Header carries the capture-mode
// toggle and (when the cursor is detached) the snap-to-live button.
//
// HC=0 is the pre-simulation point and is never recorded or rendered.
// The display window always starts at HC=1; the first visible cell is
// the bus state right after the first clockEdge.
//
// M8a scope: outputs only — input pins render at their initial level
// (deasserted high) because no UI control drives them yet (8b lands
// checkboxes + NMI button + INT vector input). VCD export lands in 8c.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { DEFAULT_HW_TRACE_RENDER_MAX_HCS } from "../../config/defaults.ts";
import {
  ALL_SIGNALS,
  BUS_VALUE_SIGNALS,
  type BusSnapshotRecord,
  type BusValueSignal,
  OUTPUT_TRI_SIGNALS,
  type SignalName,
  type Tri,
  type TriSignal,
} from "../../runloop/hwTrace.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { parsePositiveInt } from "../../util/num.ts";
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

const isTri = (name: SignalName): name is TriSignal => TRI_SET.has(name);
const isBusValue = (name: SignalName): name is BusValueSignal =>
  BUS_VALUE_SET.has(name);

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
        onClick={onStepHcN}
        disabled={!store.isPaused()}
        title={STR.hwTrace.stepNHcTooltip}
      >
        {STR.hwTrace.stepNHc}
      </button>
      <button
        type="button"
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
          checked={store.hwTraceMode() === "ring"}
          onChange={(e) =>
            store.setHwTraceMode(e.currentTarget.checked ? "ring" : "disabled")
          }
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
              class="hwt-snap"
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
    // new records land. Per DESIGN §3.2 the version advances at rAF
    // cadence (gated by `loop.onTick` in the store).
    store.hwTraceVersion();
    const capture =
      store.hwTraceMode() === "ring"
        ? STR.hwTrace.captureModeRing
        : STR.hwTrace.captureModeDisabled;
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
 * Per-signal row component (REQ §6.4 "Each signal row is an isolated
 * component instance — one per signal"). Isolation preps for post-MVP
 * drag-to-reorder of rows and keeps render cost per signal flat.
 */
const SignalRow: Component<{
  signal: SignalName;
  windowLo: number;
  windowHi: number;
  row: RowData;
  /**
   * Optional per-cell dim mask (true ⇒ render that cell dimmed). Only the
   * `addr` row passes one — it marks DRAM-refresh cells (nRFSH low) so
   * refresh addresses read distinctly from operational ones.
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
        props.windowLo,
        props.windowHi,
        width,
        props.row.initialBus,
        glyphs,
      );
      const mask = props.dimMask;
      if (mask?.length) return segmentByMask(text, mask);
    } else if (isTri(props.signal)) {
      text = renderTriRow(
        props.row.tri,
        props.windowLo,
        props.windowHi,
        props.row.initialTri,
        glyphs,
      );
    } else {
      text = renderBitRow(
        props.row.bit,
        props.windowLo,
        props.windowHi,
        props.row.initialBit,
        glyphs,
      );
    }
    return [{ text, dim: false }];
  });
  return (
    <div class="hwt-row">
      <span class="hwt-row-label">
        {STR.hwTrace.signalLabels[props.signal]}
      </span>
      <span class="hwt-row-waveform">
        <For each={segments()}>
          {(seg) =>
            seg.dim ? <span class="hwt-bus-refresh">{seg.text}</span> : seg.text
          }
        </For>
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

const Body: Component = () => {
  const store = useStore();
  let scrollEl: HTMLDivElement | undefined;

  // Render extent = the full available HC range (capped to
  // RENDER_MAX_HCS so the DOM stays bounded on long runs). The visible
  // viewport is a CSS-driven subset; horizontal scroll moves within
  // this rendered range. The cursor controls scroll POSITION, not
  // render bounds — a `live` cursor pins the scroll to the right
  // edge; a `detached` cursor leaves it where the user dragged.
  //
  // The body renders ONLY while stopped: during a run these memos return
  // their previous value untouched (they don't track `hc`/version while
  // running), so the expensive buffer walk happens once per pause, not
  // per frame. A future "live mode" would lift this gate — and would also
  // need the detached cursor to anchor render bounds, since a sliding
  // window can't hold a pinned HC while data grows.
  const renderBounds = createMemo<{ lo: number; hi: number }>(
    (prev) => {
      if (store.status() !== "paused") return prev;
      store.hwTraceVersion();
      const hi = store.hc();
      if (hi < 1) return { lo: 1, hi: 0 };
      // Clamp the left edge UP to the oldest recorded HC. `store.hc()` is a
      // free-running counter that keeps advancing while capture is DISABLED,
      // but the ring records nothing then — so a window left edge of
      // `hi - RENDER_MAX + 1` can fall before the first record. The renderer
      // would then fill `[lo, oldestHc)` with carry-forward from
      // `latestBefore(lo)` = undefined → default deasserted levels: the
      // "dead lines" bug (visible after enabling capture mid-session, when
      // HC already advanced past where the ring starts). Pinning `lo` to
      // `oldestHc()` keeps the window over real data; the carry-forward seed
      // then always has a record behind it. (`oldestHc()` is undefined only
      // when the ring is empty — then the body shows the empty/disabled
      // fallback, not rows, so the `?? 1` is never actually rendered.)
      const oldest = store.hwTrace.oldestHc() ?? 1;
      const lo = Math.max(1, hi - DEFAULT_HW_TRACE_RENDER_MAX_HCS + 1, oldest);
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
  // Gate the whole body on the ring actually holding records (head/tail
  // emptiness), NOT on store.hc(). An emptied ring after a long run still
  // leaves store.hc() large; keying off hc would render a window full of
  // carried-forward "dead lines." If there's nothing in the ring, show
  // nothing.
  const hasData = createMemo<boolean>((prev) => {
    if (store.status() !== "paused") return prev;
    store.hwTraceVersion();
    return !store.hwTrace.isEmpty();
  }, false);

  // M1-cycle start markers: the cell offset (relative to windowLo) of
  // every nM1 falling edge (1→0) inside the window. Rendered as faint
  // vertical rules so instruction boundaries are visible at a glance —
  // and as a built-in alignment ruler: because the lines live on the
  // same 1ch grid as the glyphs, any row that drifted off-grid would
  // show its glyphs sliced mid-cell by the lines. Derived from the nM1
  // bit row we already build. Walking with the carried-in level
  // (`initialBit`) avoids marking a spurious edge when the window opens
  // mid-M1 (nM1 already low, so the first emitted transition isn't a
  // real 1→0).
  const m1Starts = createMemo<number[]>(() => {
    const { lo } = renderBounds();
    const row = rowData().nM1;
    if (!row) return [];
    const offsets: number[] = [];
    let prev = row.initialBit;
    for (const t of row.bit) {
      if (prev === 1 && t.value === 0) offsets.push(t.hc - lo);
      prev = t.value;
    }
    return offsets;
  });

  // Per-cell DRAM-refresh mask: true where nRFSH is asserted (low). The
  // addr row uses it to dim refresh addresses (I:R on the bus during
  // M1 T3–T4) so they read distinctly from operational addresses. Keyed
  // purely on nRFSH level — never on whether addr changed, since a
  // refresh address can coincidentally equal the prior operational one.
  const refreshMask = createMemo<boolean[]>(() => {
    const { lo, hi } = renderBounds();
    const row = rowData().nRFSH;
    if (!row) return [];
    return bitLevelRow(row.bit, lo, hi, row.initialBit).map((v) => v === 0);
  });

  // Scroll-driven cursor management. When the user scrolls left,
  // detach the cursor at the rightmost visible HC; when they scroll
  // back to the right edge, snap to live. Mirrors the instruction-trace
  // section's scroll-bottom semantics, rotated 90°.
  const onScroll = (): void => {
    if (!scrollEl) return;
    const { lo, hi } = renderBounds();
    if (hi < lo) return;
    const atRight =
      scrollEl.scrollWidth - scrollEl.scrollLeft - scrollEl.clientWidth <
      SCROLL_PIN_EPSILON_PX;
    const cursor = store.cursors.hwTrace;
    if (atRight) {
      if (cursor.mode === "detached") store.snapHwTraceCursorToLive();
      return;
    }
    // Compute rightmost visible HC from scroll position. scrollWidth
    // covers exactly `(hi - lo + 1)` cells, so the cell-width factor
    // cancels out in the proportion.
    const totalCells = hi - lo + 1;
    const rightPx = scrollEl.scrollLeft + scrollEl.clientWidth;
    const rightProp = Math.min(1, Math.max(0, rightPx / scrollEl.scrollWidth));
    const rightmostHc = Math.min(
      hi,
      Math.max(lo, lo + Math.floor(rightProp * totalCells) - 1),
    );
    if (cursor.mode === "live") {
      store.detachHwTraceCursor(rightmostHc);
    } else if (cursor.anchorHc !== rightmostHc) {
      store.detachHwTraceCursor(rightmostHc);
    }
  };

  // Auto-pin scroll to right edge when the cursor is live. Re-fires
  // whenever data grows (version bump) or the cursor flips live (e.g.,
  // snap-to-live click / `g` hotkey). Gated on `paused` to match the
  // instruction-trace section's "frozen during run" UX — auto-scrolling
  // each tick during run would compete with the user's mid-run scroll.
  createEffect(() => {
    store.hwTraceVersion();
    const mode = store.cursors.hwTrace.mode;
    if (store.status() !== "paused") return;
    queueMicrotask(() => {
      if (!scrollEl) return;
      if (mode !== "live") return;
      scrollEl.scrollLeft = scrollEl.scrollWidth;
    });
  });

  return (
    <div
      class="hwt-body"
      ref={(el) => {
        scrollEl = el;
      }}
      onScroll={onScroll}
    >
      <Show
        when={hasData()}
        fallback={
          <span class="muted">
            {store.hwTraceMode() === "disabled"
              ? STR.hwTrace.bodyDisabled
              : STR.hwTrace.bodyEmpty}
          </span>
        }
      >
        <div class="hwt-content">
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
                windowLo={renderBounds().lo}
                windowHi={renderBounds().hi}
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
