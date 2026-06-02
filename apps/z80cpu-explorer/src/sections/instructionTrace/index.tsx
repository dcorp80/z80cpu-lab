import {
  type Component,
  createEffect,
  createMemo,
  Index,
  Show,
} from "solid-js";
import { useStore } from "../../store/index.ts";
import type { TraceRecord } from "../../store/traceRing.ts";
import { disasm } from "../../style/disasmStyle.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import type { SectionModule } from "../types.ts";

// How many instructions to forward-disassemble after current PC. REQ §6.3:
// "next ~10–20 instructions". 12 is a comfortable middle.
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
 * pipeline event. DESIGN §3.1 spells out this split.
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
  // Returning the cursor itself (not a boolean) when detached lets
  // `<Show>` hand the narrowed value to its child function. Children
  // are torn down before re-eval when the cursor flips to `live`, so
  // `c().anchorHc` is never read against a `{ mode: "live" }` slice.
  const detached = () => {
    const c = store.cursors.instructionTrace;
    return c.mode === "detached" ? c : null;
  };
  return (
    <Show when={detached()}>
      {(c) => (
        <div class="itrace-header-controls">
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
            class="itrace-snap"
            onClick={() => store.snapInstructionTraceCursorToLive()}
            title={STR.instructionTrace.snapToLiveTooltip}
          >
            {STR.instructionTrace.snapToLive}
          </button>
        </div>
      )}
    </Show>
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
    const size = store.traceRing.size();
    if (size === 0) {
      return STR.instructionTrace.foldedSummary(pc, status, insns);
    }
    const last = store.traceRing.at(size - 1);
    if (!last) {
      return STR.instructionTrace.foldedSummary(pc, status, insns);
    }
    return STR.instructionTrace.foldedSummaryWithLast(
      pc,
      status,
      insns,
      getDisasm(last),
    );
  });
  return <span class="muted">{summary()}</span>;
};

interface ExecutedRowProps {
  rec: TraceRecord;
}

const ExecutedRow: Component<ExecutedRowProps> = (props) => {
  const tag = createMemo(() => m1Tag(props.rec));
  return (
    <div class="itrace-row">
      <span class="itrace-hc">{fmt(props.rec.hc)}</span>
      <span class="itrace-addr">{formatHex(props.rec.startAddr, 4)}</span>
      <span class="itrace-bytes">{formatBytes(props.rec)}</span>
      <span class="itrace-disasm">{getDisasm(props.rec)}</span>
      <Show when={tag()}>
        <span class="itrace-tag">{tag()}</span>
      </Show>
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

const Body: Component = () => {
  const store = useStore();
  let scrollEl: HTMLDivElement | undefined;

  // Records snapshot. Two gates work together:
  //   1. Subscribe to the throttled version so we don't allocate a new
  //      array (and trigger <Index> diff) on every push during run.
  //   2. When status is not paused, return the previous snapshot
  //      unchanged. The body is frozen during run (per the user's
  //      directive and REQ §7.5) — rebuilding 10k entries every frame
  //      starves rAF when the ring is full.
  // On pause-edge: throttle flushes (store writes the current ring
  // version), status flips to paused, the memo re-runs, and the body
  // refreshes against the final state.
  const records = createMemo<TraceRecord[]>((prev) => {
    store.traceRingVersionThrottled();
    if (store.status() !== "paused") return prev;
    const n = store.traceRing.size();
    const out: TraceRecord[] = new Array(n);
    for (let i = 0; i < n; i++) {
      // Non-null assert: i is in [0, size).
      out[i] = store.traceRing.at(i) as TraceRecord;
    }
    return out;
  }, []);

  // Preview origin per DESIGN open-question option (c):
  //   - at instruction boundary: latest trace's nextPc (where exec
  //     just headed). Matches the rendered cpuState pane's "boundary
  //     view".
  //   - mid-instruction: live cpuState.pc (where the CPU is fetching
  //     from right now). Matches the dimmed pane.
  // Falls back to live pc when no trace exists yet (fresh boot).
  // Throttled — the preview is part of the frozen body during run.
  const previewPc = createMemo(() => {
    if (store.atInstructionBoundary()) {
      store.traceRingVersionThrottled();
      const n = store.traceRing.size();
      if (n > 0) {
        const last = store.traceRing.at(n - 1);
        if (last) return last.nextPc & 0xffff;
      }
    }
    return store.cpuState().pc & 0xffff;
  });

  const previewLines = createMemo<PreviewLine[]>((prev) => {
    // Track memVersion so writes (file load, etc.) refresh the preview.
    store.memVersion();
    store.traceRingVersionThrottled();
    // Same freeze gate as `records` — preview only makes sense once
    // execution has stopped.
    if (store.status() !== "paused") return prev;
    const pc0 = previewPc();
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

  // Scroll handling. On a live cursor we keep the scrollTop pinned to
  // the bottom of the executed log so new rows enter the viewport
  // naturally. User scroll-back detaches the cursor; the snap button
  // returns to live + repins.
  const onScroll = () => {
    if (!scrollEl) return;
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
      // would render if we add hwTrace cross-linking later.
      const n = store.traceRing.size();
      const last = n > 0 ? store.traceRing.at(n - 1) : undefined;
      store.detachInstructionTraceCursor(last?.hc ?? store.hc());
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
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  });

  return (
    <div class="itrace-body">
      <div class="itrace-section-label">
        {STR.instructionTrace.executedHeading}
      </div>
      <div
        class="itrace-executed"
        ref={(el) => {
          scrollEl = el;
        }}
        onScroll={onScroll}
      >
        <Show
          when={records().length > 0}
          fallback={
            <span class="muted">{STR.instructionTrace.emptyExecuted}</span>
          }
        >
          <Index each={records()}>{(rec) => <ExecutedRow rec={rec()} />}</Index>
        </Show>
      </div>
      <div class="itrace-seam">
        <span class="itrace-section-label">
          {STR.instructionTrace.previewHeading}
        </span>
        <span class="itrace-pc">{formatHex(previewPc(), 4)}</span>
      </div>
      <div class="itrace-preview">
        <Show
          when={previewLines().length > 0}
          fallback={
            <span class="muted">{STR.instructionTrace.previewEmpty}</span>
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
