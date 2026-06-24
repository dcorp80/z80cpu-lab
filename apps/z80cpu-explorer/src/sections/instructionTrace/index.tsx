import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useStore } from "../../store/index.ts";
import type { TraceRecord } from "../../store/traceRing.ts";
import { disasm } from "../../style/disasmStyle.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { parsePositiveInt } from "../../util/num.ts";
import type { SectionModule } from "../types.ts";
import {
  computeVirtualWindow,
  VIRTUAL_DEFAULT_ROW_H_PX,
  VIRTUAL_SPACER_MAX_PX,
} from "./virtualWindow.ts";

// Thin wrapper around a TraceRecord that snapshots the mutable `count` and
// `lastHc` fields at memo evaluation time. A new wrapper is allocated each
// time `records()` runs (on every traceRingVersion bump), so Solid's
// `<Index>` sees a changed item even when the underlying TraceRecord object
// was mutated in-place by a fold. The wrapper is stable enough for the
// render window; `getDisasm` caches onto `entry.rec` as before.
interface RecordEntry {
  rec: TraceRecord;
  count: number;
}

// How many instructions to forward-disassemble after current PC: 12 is a comfortable middle.
const PREVIEW_INSN_COUNT = 12;
// Max bytes a single Z80 instruction can consume (DDCB d op, DD 21 nn nn,
// DD 36 d n). Per-iteration the disasm is always handed exactly this many
// bytes — memByte wraps reads past 0xFFFF, matching what the CPU sees.
const Z80_MAX_INSTR_BYTES = 4;
// Scroll-bottom detection epsilon (px). Browsers occasionally report a
// fractional scrollTop at the true bottom (sub-pixel rounding); a small
// slack avoids spuriously detaching on a perfectly-pinned view.
const SCROLL_PIN_EPSILON_PX = 4;

const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * The m1Type tag rendered next to the row's address. `"normal"` is the
 * common case and produces no tag. Wasted-prefix M1s (DD/FD followed by
 * another prefix) arrive tagged `"normal"` but with `length === 1` —
 * we synthesize a `"PREFIX"` badge for them so the user sees the
 * pipeline event.
 */
function m1Tag(rec: TraceRecord): string | null {
  if (rec.m1Type === "normal") {
    if (rec.length === 1 && (rec.bytes[0] === 0xdd || rec.bytes[0] === 0xfd)) {
      return STR.instructionTrace.m1Tags.prefix;
    }
    return null;
  }
  return STR.instructionTrace.m1Tags[rec.m1Type];
}

/** Bare 2-hex byte cells, joined by spaces. Pads to 4 slots so columns
 *  align across rows with shorter instructions. */
function formatBytes(rec: TraceRecord): string {
  const parts: string[] = [];
  for (let i = 0; i < rec.length; i++) parts.push(formatHex(rec.bytes[i], 2));
  // Pad with two-space cells (matches the width of one byte).
  while (parts.length < 4) parts.push("  ");
  return parts.join(" ");
}

/** Lazy disasm — the record caches the text on first read, cleared on
 *  slot reuse by `TraceRing.push`. Reading via this helper keeps the
 *  cache invariant in one place. */
function getDisasm(rec: TraceRecord): string {
  if (rec.disasmText === null) {
    rec.disasmText = disasm(rec.bytes.slice(0, rec.length)).text;
  }
  return rec.disasmText;
}

const Header: Component = () => {
  const store = useStore();
  // Step / Step N are paused-only (mirrors the equivalent guards in
  // hotkeys/defaults.ts).
  const [stepN, setStepN] = createSignal("1");
  const onStepN = () => {
    const n = parsePositiveInt(stepN());
    if (n !== null) store.stepInstructions(n);
  };
  // Returning the cursor itself (not a boolean) when detached lets
  // `<Show>` hand the narrowed value to its child function. Children
  // are torn down before re-eval when the cursor flips to `live`, so
  // `c().anchorHc` is never read against a `{ mode: "live" }` slice.
  const detached = () => {
    const c = store.cursors.instructionTrace;
    return c.mode === "detached" ? c : null;
  };
  return (
    <div class="itrace-header-controls">
      <button
        type="button"
        class="btn"
        onClick={() => store.stepInstructions(1)}
        disabled={!store.isPaused() || !store.traceInstructions()}
        title={STR.instructionTrace.stepTooltip}
      >
        {STR.instructionTrace.step}
      </button>
      <input
        class="step-n-input"
        type="text"
        inputmode="numeric"
        value={stepN()}
        onInput={(e) => setStepN(e.currentTarget.value)}
        aria-label={STR.instructionTrace.stepCountLabel}
        disabled={!store.traceInstructions()}
        size={4}
      />
      <button
        type="button"
        class="btn"
        onClick={onStepN}
        disabled={!store.isPaused() || !store.traceInstructions()}
        title={STR.instructionTrace.stepNTooltip}
      >
        {STR.instructionTrace.stepN}
      </button>
      <label
        class="itrace-capture-mode"
        title={STR.instructionTrace.captureToggleTooltip}
      >
        <input
          type="checkbox"
          aria-label={STR.instructionTrace.captureToggleAriaLabel}
          checked={store.capture()}
          disabled={!store.isPaused() || !store.traceInstructions()}
          onChange={(e) => store.setCapture(e.currentTarget.checked)}
        />
        <span class="itrace-capture-mode-label">
          {STR.instructionTrace.captureToggleLabel}
        </span>
      </label>
      <Show when={detached()}>
        {(c) => (
          <>
            <span
              class="itrace-detached-badge"
              title={STR.instructionTrace.detachedBadgeTooltip(
                formatHex(c().anchorHc, 0),
              )}
            >
              {STR.instructionTrace.detachedBadge}
            </span>
            <button
              type="button"
              class="btn itrace-snap"
              onClick={() => store.snapInstructionTraceCursorToLive()}
              title={STR.instructionTrace.snapToLiveTooltip}
            >
              {STR.instructionTrace.snapToLive}
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
    // Throttled subscription: at most one summary refresh per rAF
    // during run, immediate when paused.
    store.traceRingVersionThrottled();
    const status = (() => {
      switch (store.status()) {
        case "running":
          return STR.instructionTrace.statusRunning;
        case "stepping":
          return STR.instructionTrace.statusStepping;
        default:
          return STR.instructionTrace.statusPaused;
      }
    })();
    const pc = formatHex(store.cpuState().pc, 4);
    // Same rationale as the BP status line — use the throttled mirror
    // so the folded summary refreshes once per frame, not per insn.
    const insns = fmt(store.insnCountThrottled());
    // Mirrors the HW-trace folded summary: "capture: ring/off" surfaces
    // capture state when the section is folded, so the user can see at a
    // glance that the ring stopped recording.
    const capture = store.capture();
    const size = store.traceRing.size();
    if (size === 0) {
      return STR.instructionTrace.foldedSummary(pc, status, insns, capture);
    }
    const last = store.traceRing.at(size - 1);
    if (!last) {
      return STR.instructionTrace.foldedSummary(pc, status, insns, capture);
    }
    return STR.instructionTrace.foldedSummaryWithLast(
      pc,
      status,
      insns,
      capture,
      getDisasm(last),
    );
  });
  return <span class="muted">{summary()}</span>;
};

interface ExecutedRowProps {
  entry: RecordEntry;
  /** Px offset within the virtualization spacer. Applied as inline
   *  `top`; CSS pins the row absolutely with the canonical row height. */
  top: number;
}

const ExecutedRow: Component<ExecutedRowProps> = (props) => {
  const tag = createMemo(() => m1Tag(props.entry.rec));
  // Single read of `count` shared by aria-hidden and the badge text —
  // both depend on the same threshold.
  const folded = () => props.entry.count > 1;
  // Layout mirrors Preview / Current: an empty 1ch gutter slot keeps
  // addr / bytes / disasm column-aligned across all three panes. HC
  // sits after disasm (was leftmost — growing digit counts shifted
  // the trace visually); m1Type tag stays at the far right.
  return (
    <div class="itrace-row" style={{ top: `${props.top}px` }}>
      <span class="itrace-gutter" aria-hidden="true" />
      <span class="itrace-addr">{formatHex(props.entry.rec.startAddr, 4)}</span>
      <span class="itrace-bytes">{formatBytes(props.entry.rec)}</span>
      <span class="itrace-disasm">{getDisasm(props.entry.rec)}</span>
      <span class="itrace-hc">{fmt(props.entry.rec.hc)}</span>
      <span class="itrace-repeat-badge" aria-hidden={!folded()}>
        {folded() ? STR.instructionTrace.repeatBadge(props.entry.count) : ""}
      </span>
      <span class="itrace-tag">{tag() ?? ""}</span>
    </div>
  );
};

interface PreviewLine {
  addr: number;
  bytes: number[];
  text: string;
}

interface PreviewRowProps {
  line: PreviewLine;
}

/**
 * Preview row. The leading address is a click target: clicking toggles
 * an exact-match (hi===lo===addr) PC breakpoint. A wider range BP that
 * happens to cover the address is NOT touched — clicking only manages
 * the single-PC BPs created from this surface. The gutter dot lights
 * up whenever ANY enabled pc-range BP covers the address (single-PC or
 * wider) so the visual rule reads "would this stop here?".
 */
const PreviewRow: Component<PreviewRowProps> = (props) => {
  const store = useStore();

  // True iff any enabled pc-range BP covers this address (single-PC or
  // wider range). Drives the gutter dot.
  const bpCovers = createMemo(() => {
    const a = props.line.addr;
    for (const bp of store.breakpoints) {
      if (bp.kind !== "pc-range") continue;
      if (!bp.enabled) continue;
      if (a >= bp.lo && a <= bp.hi) return true;
    }
    return false;
  });

  // True iff a BP exists with exact match hi===lo===addr (whether or
  // not enabled). Drives the toggle action.
  const exactBp = createMemo(() => {
    const a = props.line.addr;
    for (const bp of store.breakpoints) {
      if (bp.kind === "pc-range" && bp.lo === a && bp.hi === a) return bp;
    }
    return null;
  });

  const onAddrClick = () => {
    const ex = exactBp();
    if (ex) {
      store.removeBreakpoint(ex.id);
    } else {
      store.addBreakpoint({
        kind: "pc-range",
        lo: props.line.addr,
        hi: props.line.addr,
      });
    }
  };

  return (
    <div class="itrace-row is-preview" classList={{ "has-bp": bpCovers() }}>
      <span class="itrace-bp-marker" aria-hidden="true" />
      <button
        type="button"
        class="itrace-addr itrace-addr-btn"
        onClick={onAddrClick}
        title={
          exactBp()
            ? STR.instructionTrace.previewAddrRemoveBpTooltip
            : STR.instructionTrace.previewAddrAddBpTooltip
        }
      >
        {formatHex(props.line.addr, 4)}
      </button>
      <span class="itrace-bytes">
        {props.line.bytes
          .map((b) => formatHex(b, 2))
          .concat(Array(4 - props.line.bytes.length).fill("  "))
          .join(" ")}
      </span>
      <span class="itrace-disasm">{props.line.text}</span>
    </div>
  );
};

interface CurrentLine {
  addr: number;
  bytes: readonly number[];
  text: string;
  nextPc: number;
  /** NMI/INT/HALT/special_reset tag, if any — we render the tag for
   *  non-"normal" M1s even mid-instruction since the type is known
   *  from the M1 start (set in `_initFreshCurr`). The "PREFIX"
   *  synthetic that ExecutedRow renders for completed length-1 DD/FD
   *  traces is NOT mirrored here: at length=1 in flight, the trace
   *  may still extend to DDCB / DD nn — too early to declare a
   *  wasted prefix. */
  tag: string | null;
}

interface CurrentRowProps {
  line: CurrentLine;
}

/**
 * In-flight instruction row, shown between Executed and Preview when
 * the loop is paused mid-instruction. Read-only: the address is not a
 * BP toggle (the in-flight instruction's start is already either in
 * Executed history or is the next preview row at boundary). Gutter
 * shows a `>` glyph to mark "this is what's running."
 */
const CurrentRow: Component<CurrentRowProps> = (props) => {
  return (
    <div class="itrace-row is-current">
      <span class="itrace-current-marker" aria-hidden="true">
        &gt;
      </span>
      <span class="itrace-addr">{formatHex(props.line.addr, 4)}</span>
      <span class="itrace-bytes">
        {props.line.bytes
          .map((b) => formatHex(b, 2))
          .concat(Array(4 - props.line.bytes.length).fill("  "))
          .join(" ")}
      </span>
      <span class="itrace-disasm">{props.line.text}</span>
      <span class="itrace-tag">{props.line.tag ?? ""}</span>
    </div>
  );
};

const Body: Component = () => {
  const store = useStore();
  let scrollEl: HTMLDivElement | undefined;

  // Virtualization state: viewport metrics drive which slice of the
  // (potentially massive) Executed log is mounted. With tens of
  // thousands of rows in the ring, mounting all of them stalls layout
  // every paused step.
  // `scrollTop` updates from `onScroll`; `viewportH` from a ResizeObserver
  // on the scroll container; `rowH` is read once from the CSS custom
  // property `--itrace-row-h` on mount.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);
  const [rowH, setRowH] = createSignal(VIRTUAL_DEFAULT_ROW_H_PX);

  // Records snapshot. Two gates work together:
  //   1. Subscribe to the throttled version so we don't allocate a new
  //      array (and trigger <Index> diff) on every push during run.
  //   2. When status is not paused, return the previous snapshot
  //      unchanged. The body is frozen during run (per the user's
  //      — rebuilding 10k entries every frame
  //      starves rAF when the ring is full.
  // On pause-edge: throttle flushes (store writes the current ring
  // version), status flips to paused, the memo re-runs, and the body
  // refreshes against the final state.
  // Each memo run produces NEW wrapper objects so Solid's `<Index>` detects
  // in-place-folded records as "changed" even though the underlying
  // TraceRecord reference stays the same. The `count` snapshot is what
  // drives the ×N badge; `rec` is passed through for disasm / bytes / addr.
  const records = createMemo<RecordEntry[]>((prev) => {
    store.traceRingVersionThrottled();
    if (store.status() !== "paused") return prev;
    const n = store.traceRing.size();
    const out: RecordEntry[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = store.traceRing.at(i) as TraceRecord;
      out[i] = { rec: r, count: r.count };
    }
    return out;
  }, []);

  // In-flight instruction row. Sourced from the store's pause-time
  // snapshot of `dbg.curr` (null when no instruction is in flight —
  // cold boot before any M1 T3_0 has run).
  //
  // `cur.nextPc` is the single source of truth for the preview origin
  // below: the dbg seeds `curr.nextPc = startAddr` in `_initFreshCurr`
  // and overwrites it with the actual next-M1 PC at the next M1 T1_0,
  // so reading it is always sensible — sequential mid-instruction,
  // jump/call/ret target during the 2-HC window between the next M1's
  // T1_0 and T3_0.
  const currentLine = createMemo<CurrentLine | null>(() => {
    if (store.status() !== "paused") return null;
    // When tracing is off dbg.enabled is false → `dbg.curr` never refreshes,
    // so the snapshot the store grabbed on the last pause is stale. Suppress
    // the row rather than render a zero/garbage address. Capture (the ring
    // push) is orthogonal — the in-flight curr is fresh whenever tracing
    // is on, regardless of whether each completed instruction is being
    // pushed into the ring.
    if (!store.traceInstructions()) return null;
    const cur = store.currentInstruction();
    if (!cur) return null;
    // Disasm tolerates short input: `readN` / `readNN` return
    // `STYLE.incomplete` when bytes run out, so partial captures
    // produce a best-effort text (e.g. "LD A,??" for 3E without
    // operand). Pass exactly the captured bytes — no top-up from
    // memory — so the row reads as "what the CPU has actually seen
    // so far," not "what the encoding is expected to become."
    const d = disasm(cur.bytes);
    return {
      addr: cur.startAddr,
      bytes: cur.bytes,
      text: d.text,
      nextPc: cur.nextPc,
      tag:
        cur.m1Type === "normal"
          ? null
          : STR.instructionTrace.m1Tags[cur.m1Type],
    };
  });

  // Preview origin: in-flight `nextPc` (which the dbg keeps meaningful
  // at all times). Null when tracing is off — dbg.curr is stale so we
  // have no reliable position; the preview is suppressed in that case.
  const previewOrigin = (): number | null =>
    !store.traceInstructions() ? null : (currentLine()?.nextPc ?? 0);

  const previewLines = createMemo<PreviewLine[]>((prev) => {
    // Track memVersion so writes (file load, etc.) refresh the preview.
    store.memVersion();
    store.traceRingVersionThrottled();
    // Same freeze gate as `records` — preview only makes sense once
    // execution has stopped.
    if (store.status() !== "paused") return prev;
    const pc0 = previewOrigin();
    // No reliable position when capture is off.
    if (pc0 === null) return [];
    const lines: PreviewLine[] = [];
    let offset = 0;
    for (let i = 0; i < PREVIEW_INSN_COUNT; i++) {
      // Always hand the disasm the full 4-byte max-instruction window.
      // Reading directly via memByte (rather than pre-filling a fixed
      // array) sidesteps tail-of-window underflow and lets memByte's
      // address mask wrap reads past 0xFFFF — matching the CPU.
      const slice: number[] = new Array(Z80_MAX_INSTR_BYTES);
      for (let b = 0; b < Z80_MAX_INSTR_BYTES; b++) {
        slice[b] = store.memByte(pc0 + offset + b);
      }
      const d = disasm(slice);
      if (d.length === 0) break;
      lines.push({
        addr: (pc0 + offset) & 0xffff,
        bytes: slice.slice(0, d.length),
        text: d.text,
      });
      offset += d.length;
    }
    return lines;
  }, []);

  // Virtualization derivations. `windowRange` maps the scroll position +
  // viewport to the inclusive-exclusive index range that should be
  // mounted; `windowSlice` is the record array passed to `<Index>`;
  // `spacerH` is the spacer's virtual height (drives the scrollbar).
  // `equals` on windowRange suppresses no-op rerenders: every scroll
  // event writes scrollTop, but the window only shifts when scrollTop
  // crosses a rowH boundary — without the predicate, windowSlice and
  // each row's `top` binding refire 60+ times/sec during smooth scroll.
  const windowRange = createMemo(
    () =>
      computeVirtualWindow(scrollTop(), viewportH(), rowH(), records().length),
    undefined,
    { equals: (a, b) => a.first === b.first && a.last === b.last },
  );
  const windowSlice = createMemo(() => {
    const w = windowRange();
    return records().slice(w.first, w.last);
  });
  // Clamp to Chrome's max element height. The current ring cap (10 000
  // × 20 px) is nowhere near, but a future cap bump above ~1.6 M rows
  // would silently desync the scrollbar from the window math.
  const spacerH = createMemo(() =>
    Math.min(records().length * rowH(), VIRTUAL_SPACER_MAX_PX),
  );

  // Ref captures the element; measurement runs in onMount so the
  // initial signal writes (rowH/scrollTop/viewportH) don't trigger a
  // mid-render re-flow. ResizeObserver keeps viewportH live for section
  // unfold, body resize, and font-size changes via zoom.
  const setScrollRef = (el: HTMLDivElement) => {
    scrollEl = el;
  };
  onMount(() => {
    if (!scrollEl) return;
    const cssRowH = getComputedStyle(scrollEl)
      .getPropertyValue("--itrace-row-h")
      .trim();
    const parsed = Number.parseFloat(cssRowH);
    if (Number.isFinite(parsed) && parsed > 0) setRowH(parsed);
    setScrollTop(scrollEl.scrollTop);
    setViewportH(scrollEl.clientHeight);
    const ro = new ResizeObserver(() => {
      if (!scrollEl) return;
      setViewportH(scrollEl.clientHeight);
    });
    ro.observe(scrollEl);
    onCleanup(() => ro.disconnect());
  });

  // Scroll handling. On a live cursor we keep the scrollTop pinned to
  // the bottom of the executed log so new rows enter the viewport
  // naturally. User scroll-back detaches the cursor; the snap button
  // returns to live + repins. Also feeds the virtualization window.
  const onScroll = () => {
    if (!scrollEl) return;
    setScrollTop(scrollEl.scrollTop);
    const atBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <
      SCROLL_PIN_EPSILON_PX;
    const cursor = store.cursors.instructionTrace;
    if (atBottom) {
      if (cursor.mode === "detached") store.snapInstructionTraceCursorToLive();
      return;
    }
    if (cursor.mode === "live") {
      // Pin the cursor at the newest visible record's HC. Approximation
      // is fine — anchor only affects which historical HC the section
      // would render if we add hwTrace cross-linking later. Use `lastHc`
      // so a folded run (LDIR/HALT/JR $) anchors at the latest iteration,
      // not the first one tens of thousands of HC earlier.
      const n = store.traceRing.size();
      const last = n > 0 ? store.traceRing.at(n - 1) : undefined;
      store.detachInstructionTraceCursor(last?.lastHc ?? store.hc());
    }
  };

  // Auto-pin to bottom whenever (a) the record set grows or (b) the
  // cursor flips back to live (after a snap from detached). We can't
  // measure layout from inside the memo above, so we schedule the
  // scroll via a microtask after the DOM has updated.
  //
  // Gated on paused — the body is frozen during run, so pinning would
  // do nothing visible AND risks fighting the user's mid-run scroll
  // back through history.
  createEffect(() => {
    records();
    // Subscribe to the cursor slice so a detached→live transition
    // (snap-to-live click or `g` hotkey) refires the pin even when
    // the ring hasn't changed.
    const mode = store.cursors.instructionTrace.mode;
    if (store.status() !== "paused") return;
    queueMicrotask(() => {
      if (!scrollEl) return;
      if (mode !== "live") return;
      // Update the reactive scrollTop FIRST so windowRange/Slice
      // recompute and rows reposition synchronously, then commit the
      // imperative scroll. Otherwise the browser may paint with the
      // new spacer height + old row positions (a blank gap at the
      // bottom) before the async `scroll` event reaches onScroll.
      const newTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      setScrollTop(newTop);
      scrollEl.scrollTop = newTop;
    });
  });

  return (
    <div class="itrace-body">
      <div class="itrace-section-label">
        {STR.instructionTrace.executedHeading}
      </div>
      <div class="itrace-executed" ref={setScrollRef} onScroll={onScroll}>
        <Show
          when={store.capture()}
          fallback={
            <span class="muted">{STR.instructionTrace.executedDisabled}</span>
          }
        >
          <Show
            when={records().length > 0}
            fallback={
              <span class="muted">{STR.instructionTrace.emptyExecuted}</span>
            }
          >
            <div
              class="itrace-virt-spacer"
              style={{ height: `${spacerH()}px` }}
            >
              <Index each={windowSlice()}>
                {(entry, i) => (
                  <ExecutedRow
                    entry={entry()}
                    top={(windowRange().first + i) * rowH()}
                  />
                )}
              </Index>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={currentLine()}>
        {(line) => (
          <>
            <div class="itrace-seam">
              <span class="itrace-section-label">
                {STR.instructionTrace.currentHeading}
              </span>
            </div>
            <div class="itrace-current">
              <CurrentRow line={line()} />
            </div>
          </>
        )}
      </Show>
      <div class="itrace-seam">
        <span class="itrace-section-label">
          {STR.instructionTrace.previewHeading}
        </span>
        {/* `Show when={0}` is falsy — would hide the address at cold boot
            (PC=0 is a valid origin). Explicit null check instead. */}
        <Show when={previewOrigin() !== null}>
          <span class="itrace-pc">{formatHex(previewOrigin() ?? 0, 4)}</span>
        </Show>
      </div>
      <div class="itrace-preview">
        <Show
          when={previewLines().length > 0}
          fallback={
            <span class="muted">
              {store.traceInstructions()
                ? STR.instructionTrace.previewEmpty
                : STR.instructionTrace.previewTrackingOff}
            </span>
          }
        >
          <Index each={previewLines()}>
            {(line) => <PreviewRow line={line()} />}
          </Index>
        </Show>
      </div>
    </div>
  );
};

export const instructionTrace: SectionModule = {
  id: "instructionTrace",
  title: STR.instructionTrace.title,
  Header,
  FoldedSummary,
  Body,
};
