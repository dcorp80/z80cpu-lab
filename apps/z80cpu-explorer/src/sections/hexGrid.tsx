// Shared hex grid. Renders one full page of
// rows under a virtualized viewport. The page is implied by
// `pageBase(watchAddr, pageSize)`; only `windowSlice` rows stay
// mounted at a time. Reused by Memory and IO; ASCII column is the
// only structural difference (mem: on, io: off).
//
// Reactivity is split for the same-page short-circuit (M5):
//   - `pageStart`  — pageBase memo; dedups on value, so watchAddr
//                    moves WITHIN the same page produce no notification.
//   - `pageRows`   — bytes-only rows; only re-reads on a page change,
//                    bytesPerRow change, pageSize change, or version
//                    bump (writes). The hot allocator.
//   - `watchRowAddr` / `watchOffset` — cheap overlay memos; JSX folds
//                    them in per row / per cell.
// Edits commit through `setByte` and bump the matching version.
// Per-cell edits are local input state; `paused()` gates the input
// (the store enforces the gate too).
//
// Rapid entry (Enter advances to the next cell): on a successful Enter
// commit the cell calls `advance(addr, lane)` which (a) crosses to the
// next page when the just-edited byte is the page's last and (b)
// DOM-clicks the next cell's button so it opens its editor. Hex and
// ASCII columns are independent advance lanes. Invalid Enter reverts
// the local text and KEEPS the cell focused so the user can immediately
// retype (rapid-entry rule: next cell auto-focuses on valid input).

import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  Show,
} from "solid-js";
import { STR } from "../style/strings.ts";
import { formatHex } from "../util/hex.ts";
import { HexCell } from "./hexCell.tsx";
import {
  computeVirtualWindow,
  VIRTUAL_DEFAULT_ROW_H_PX,
} from "./instructionTrace/virtualWindow.ts";
import { nextPageBase, pageBase, pageLastAddr } from "./paging.ts";

export interface HexGridProps {
  /** Read a byte at the given 16-bit address. Implementations should
   *  track their own version signal so consumers re-render on writes. */
  read: (addr: number) => number;
  /** Version signal — subscribing inside our memo couples re-renders
   *  to actual byte changes rather than to `read` reference identity. */
  version: Accessor<number>;
  /** Paused-only write path; the store enforces the same gate. */
  setByte: (addr: number, value: number) => void;
  paused: Accessor<boolean>;
  /** Memory wants both columns; IO only wants bytes (no char semantics on ports). */
  showBytes: Accessor<boolean>;
  showAscii: Accessor<boolean>;
  watchAddr: Accessor<number>;
  /** Used by the rapid-entry advance to land watchAddr on the next page's
   *  base when Enter happens on the page's last byte. */
  setWatchAddr: (addr: number) => void;
  /** Event signal — bumps on Enter from the watch input. Scrolls the
   *  watch row into view as a side effect. */
  jumpVersion: Accessor<number>;
  /** Page size for the address-page pagination model. The
   *  body renders one full page at a time; the page being displayed
   *  is `viewPageBase`. One of `PAGE_SIZE_OPTIONS`. */
  pageSize: Accessor<number>;
  /** Page currently displayed — decoupled from `watchAddr` so page-nav
   *  buttons can move the view without disturbing the marker. The grid
   *  resets its scroll position whenever this changes. */
  viewPageBase: Accessor<number>;
  /** Bytes per row — 16 / 32 / 64 / 128. Row base addresses align to
   *  this size (mask = ~(bpr - 1)) and the cell grid uses the matching
   *  `.cells-N` CSS class. */
  bytesPerRow: Accessor<number>;
  /** Optional sink for "is the watch row currently visible". HexGrid
   *  computes visibility from pageBase(watchAddr) === viewPageBase
   *  AND the watch row pixel range overlapping the scroll viewport,
   *  and emits true/false through this callback. The Memory and IO
   *  section headers read the matching store signal to gate the
   *  "recall watch" button. Optional so test mounts can omit it. */
  setWatchOnView?: (visible: boolean) => void;
}

interface PageRow {
  /** Row-aligned base address. */
  addr: number;
  /** Zero-copy view into the page-level Uint8Array buffer. Typed as
   *  Uint8Array so the data model is honest; the `<Index each>` site
   *  casts to `readonly number[]` for Solid's typing. Indexing into a
   *  Uint8Array returns a number, which is what HexCell wants. */
  bytes: Uint8Array;
}

interface PageData {
  /** Address-space base of the page currently in `buf`. */
  start: number;
  /** Page contents — one byte per address from `start` to
   *  `start + buf.length`. Owned by the HexGrid instance; reused
   *  across recomputes (only re-allocated when pageSize changes). */
  buf: Uint8Array;
}

type Lane = "hex" | "ascii";

/** Printable-ASCII guard for the ASCII column. Z80 programs frequently
 *  store data with the high bit set or use 0..1F as token codes; both
 *  render as the configured placeholder so the column stays aligned. */
function asciiGlyph(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  return STR.hexGrid.nonPrintable;
}

interface AsciiCellProps {
  addr: number;
  byte: number;
  isWatch: boolean;
  paused: Accessor<boolean>;
  setByte: (addr: number, value: number) => void;
  advance: (addr: number) => void;
}

const AsciiCell: Component<AsciiCellProps> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");
  // Reachable via paste/IME of a multi-code-unit glyph (emoji etc.):
  // maxLength clamps to 1 char, but `charCodeAt(0)` of a surrogate
  // pair returns 0xD800–0xDBFF, which trips the 0..0xff guard.
  const [invalid, setInvalid] = createSignal(false);

  /** Accept any single 0..255 byte; the user explicitly typed it, even
   *  if the glyph renders as `.` in the column. */
  const tryCommit = (): "ok" | "invalid" | "empty" => {
    const t = text();
    if (t === "") return "empty";
    const code = t.charCodeAt(0);
    if (code < 0 || code > 0xff) return "invalid";
    props.setByte(props.addr, code);
    return "ok";
  };

  const beginEdit = () => {
    if (!props.paused()) return;
    setText(asciiGlyph(props.byte));
    setInvalid(false);
    setEditing(true);
  };

  return (
    <button
      type="button"
      class="hex-ascii-cell"
      classList={{
        "is-watch-cell": props.isWatch,
        "is-editable": props.paused(),
      }}
      tabIndex={-1}
      data-addr={formatHex(props.addr, 4)}
      onClick={beginEdit}
    >
      <Show when={editing()} fallback={<span>{asciiGlyph(props.byte)}</span>}>
        <input
          type="text"
          class="hex-ascii-input"
          classList={{ "is-invalid": invalid() }}
          aria-label={STR.hexGrid.cellAsciiEditAriaLabel(
            formatHex(props.addr, 4),
          )}
          maxLength={1}
          value={text()}
          ref={(el) => {
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const result = tryCommit();
              if (result === "ok") {
                setText("");
                setInvalid(false);
                props.advance(props.addr);
                (e.currentTarget as HTMLInputElement).blur();
              } else if (result === "invalid") {
                // Mirror HexCell: flash, revert text, keep editing so
                // the user can retype without re-clicking.
                setInvalid(true);
                setText("");
              } else {
                (e.currentTarget as HTMLInputElement).blur();
              }
            } else if (e.key === "Escape") {
              setText("");
              setInvalid(false);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          onBlur={() => {
            // Mirror Enter's invalid path on out-of-range chars (paste
            // of a surrogate pair / multi-code-unit glyph → charCodeAt(0)
            // returns 0xD800–0xDBFF, tripping the 0..0xff guard inside
            // tryCommit). Flash + revert and keep editing so the user
            // sees their input was rejected. Pre-fix behavior silently
            // closed the cell on invalid blur, leaving the byte
            // untouched with no feedback — the user thought they'd
            // edited a byte but hadn't.
            const result = tryCommit();
            if (result === "invalid") {
              setInvalid(true);
              setText("");
              return;
            }
            setEditing(false);
            setInvalid(false);
          }}
        />
      </Show>
    </button>
  );
};

export const HexGrid: Component<HexGridProps> = (props) => {
  // Page base — comes from viewPageBase (page-nav / recall / watch
  // input set it). Re-snap to the current pageSize alignment defensively
  // in case pageSize changed since the addr was stored. Solid's
  // default `===` equals check on memo output means watchAddr moves
  // WITHIN the same page don't notify downstream consumers, so
  // `pageData` doesn't re-run and we avoid re-reading the whole page.
  const pageStart = createMemo(() =>
    pageBase(props.viewPageBase(), props.pageSize()),
  );

  // Single page-level buffer, reused across version bumps. Re-allocated
  // only when pageSize changes (rare — the App-shell select). At 4 KB
  // default this is one 4 KB Uint8Array owned by the component for
  // its lifetime.
  let pageBuf: Uint8Array | null = null;

  // Bytes-only page data. Subscribes to: version + pageStart + pageSize
  // + props.read identity. Fills `pageBuf` in place; returns a fresh
  // wrapper `{ start, buf }` each call so Solid's `===` dedup lets
  // downstream consumers know the contents may have changed without
  // re-allocating the buffer itself. Same-page watchAddr moves leave
  // pageStart unchanged → memo doesn't re-run → no byte reads.
  const pageData = createMemo<PageData>(() => {
    props.version();
    const ps = props.pageSize();
    const start = pageStart();
    if (!pageBuf || pageBuf.length !== ps) {
      pageBuf = new Uint8Array(ps);
    }
    for (let i = 0; i < ps; i++) {
      pageBuf[i] = props.read((start + i) & 0xffff);
    }
    return { start, buf: pageBuf };
  });

  // Row count of the current page — used by virtualization derivations
  // that previously read `pageRows().length`.
  const rowCount = createMemo(() => props.pageSize() / props.bytesPerRow());

  // Watch-state overlay — cheap memos derived from watchAddr alone, no
  // byte reads. JSX checks `row.addr === watchRowAddr()` per row /
  // `colIdx === watchOffset()` per cell, and the row-level `&&`
  // short-circuit means non-watch rows don't subscribe to watchOffset.
  const watchRowAddr = createMemo(
    () => props.watchAddr() & 0xffff & ~(props.bytesPerRow() - 1),
  );
  const watchOffset = createMemo(
    () => props.watchAddr() & (props.bytesPerRow() - 1),
  );

  // The scroll container — same element used for the per-cell advance
  // querySelector. Also drives virtualization: scrollTop +
  // viewportH + rowH derive which slice of `pageRows()` is mounted.
  let gridEl: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);
  const [rowH, setRowH] = createSignal(VIRTUAL_DEFAULT_ROW_H_PX);

  // Watch row index — math, not a walk. Used to position the jump
  // scroll target; the row may be virtualized out at jump time so we
  // can't rely on a DOM ref.
  const watchRowIndex = createMemo(
    () => ((watchRowAddr() - pageStart()) & 0xffff) / props.bytesPerRow(),
  );

  // Subscribe to the jump event; queueMicrotask lets the row layout
  // settle before we scroll. Skip the initial run — createEffect fires
  // once at subscription time, which on app boot would scroll the
  // whole page down into the Memory section even though the user
  // never requested a jump. The prev-undefined seed pattern matches
  // HexAddrInput's resetSignal handling.
  createEffect((prev: number | undefined) => {
    const v = props.jumpVersion();
    if (prev !== undefined) {
      queueMicrotask(() => {
        if (!gridEl) return;
        const idx = watchRowIndex();
        const rh = rowH();
        const vh = viewportH() || gridEl.clientHeight;
        // Center the watch row in the viewport (matches the previous
        // `scrollIntoView({block: 'center'})` behavior). Smooth scroll
        // preserved via scrollTo.
        const targetTop = Math.max(0, idx * rh - vh / 2 + rh / 2);
        gridEl.scrollTo({ top: targetTop, behavior: "smooth" });
      });
    }
    return v;
  }, undefined);

  // Reset scroll to the page top whenever the view jumps to a new
  // page. Catches page-nav clicks, recall, and the cross-page
  // rapid-entry advance — all funnel through setViewPageBase. Skip
  // the initial run with the prev-undefined seed pattern so a fresh
  // boot doesn't scroll an already-zero scroll position (no harm,
  // but the createEffect would fire spuriously on mount).
  createEffect((prev: number | undefined) => {
    const vb = pageStart();
    if (prev !== undefined && prev !== vb) {
      if (gridEl) {
        gridEl.scrollTop = 0;
        setScrollTop(0);
      }
    }
    return vb;
  }, undefined);

  /** Common advance handler — called by both HexCell and AsciiCell on
   *  a successful Enter commit. Page-aware: when the just-edited byte
   *  is the last cell of the current page, jumps both `watchAddr` and
   *  `viewPageBase` to the next page's base (auto-cross). The
   *  view-changed effect above handles the scroll-to-top reset.
   *  Wrap-around at 0xFFFF is intentional — `nextPageBase` returns
   *  null at the last page, in which case `next` wraps to 0x0000 and
   *  we re-anchor at page 0. */
  const advance = (lane: Lane, currentAddr: number): void => {
    const next = (currentAddr + 1) & 0xffff;
    const ps = props.pageSize();
    const crossingPage = currentAddr === pageLastAddr(props.viewPageBase(), ps);
    if (crossingPage) {
      const np = nextPageBase(props.viewPageBase(), ps);
      const dest = np ?? 0;
      // The user is "editing as watch" across the boundary, so the
      // marker tracks the edit position. setWatchAddr auto-syncs
      // viewPageBase in the store, so one call covers both.
      props.setWatchAddr(dest);
    }
    // Defer through two microtasks so Solid's row memo can re-run and
    // the cells re-render with new addrs before we go looking. The
    // first microtask runs after the synchronous reactive flush; the
    // second waits for the DOM mutation queued by `<Index>`.
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (!gridEl) return;
        const cls = lane === "hex" ? "hex-cell" : "hex-ascii-cell";
        const el = gridEl.querySelector(
          `.${cls}[data-addr="${formatHex(next, 4)}"]`,
        ) as HTMLElement | null;
        el?.click();
      });
    });
  };

  // Virtualization derivations. Only the visible window + overscan
  // stays mounted; the spacer reserves the full page's pixel height
  // so the scrollbar reflects the entire virtual range. windowSlice
  // builds row objects on demand from pageData — allocates only the
  // ~visible+overscan rows, not the full page (~256 at default).
  const windowRange = createMemo(() =>
    computeVirtualWindow(scrollTop(), viewportH(), rowH(), rowCount()),
  );
  const windowSlice = createMemo<PageRow[]>(() => {
    const w = windowRange();
    const pd = pageData();
    const bpr = props.bytesPerRow();
    const len = w.last - w.first;
    const out: PageRow[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const r = w.first + i;
      const rowAddr = (pd.start + r * bpr) & 0xffff;
      out[i] = {
        addr: rowAddr,
        // Zero-copy view into the page buffer.
        bytes: pd.buf.subarray(r * bpr, r * bpr + bpr),
      };
    }
    return out;
  });
  const spacerH = createMemo(() => rowCount() * rowH());

  // Emit watch visibility to the parent (header's recall button).
  // Visible iff (1) the watch's page is the one being shown AND
  // (2) the watch row's pixel range overlaps the scroll viewport.
  // Pre-mount (vh<=0 — happy-dom, or before layout settles) is
  // treated as visible so the button doesn't flash during boot.
  createEffect(() => {
    if (!props.setWatchOnView) return;
    const watchPage = pageBase(props.watchAddr(), props.pageSize());
    if (watchPage !== pageStart()) {
      props.setWatchOnView(false);
      return;
    }
    const vh = viewportH();
    if (vh <= 0) {
      props.setWatchOnView(true);
      return;
    }
    const rh = rowH();
    const top = watchRowIndex() * rh;
    const st = scrollTop();
    props.setWatchOnView(top + rh > st && top < st + vh);
  });

  // Ref callback: capture the scroll element, read `--hex-row-h` from
  // CSS, take initial viewport metrics, attach a ResizeObserver to
  // refresh on container size changes (section unfold, body resize).
  const setGridRef = (el: HTMLDivElement) => {
    gridEl = el;
    const cssRowH = getComputedStyle(el).getPropertyValue("--hex-row-h").trim();
    const parsed = Number.parseFloat(cssRowH);
    if (Number.isFinite(parsed) && parsed > 0) setRowH(parsed);
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => {
      if (!gridEl) return;
      setViewportH(gridEl.clientHeight);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  // rAF-coalesce the scroll handler — the browser can fire `scroll` at
  // 60+ Hz, each event invalidates windowRange/windowSlice and triggers
  // JSX re-evaluation. Folding multiple events into one update per
  // animation frame caps that to 60 Hz regardless of input rate.
  let scrollRafId: number | null = null;
  const onScroll = () => {
    if (!gridEl) return;
    if (scrollRafId !== null) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      if (gridEl) setScrollTop(gridEl.scrollTop);
    });
  };
  onCleanup(() => {
    if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
  });

  return (
    <div class="hex-grid" ref={setGridRef} onScroll={onScroll}>
      <div class="hex-virt-spacer" style={{ height: `${spacerH()}px` }}>
        <Index each={windowSlice()}>
          {(row, i) => {
            const top = () => (windowRange().first + i) * rowH();
            // Per-row memo: dedups so non-flipping rows don't re-render
            // their cells when watchRowAddr changes elsewhere.
            const isRowWatch = createMemo(() => row().addr === watchRowAddr());
            return (
              <div
                class="hex-row"
                classList={{ "is-watch-row": isRowWatch() }}
                style={{ transform: `translateY(${top()}px)` }}
              >
                <span class="hex-row-addr">{formatHex(row().addr, 4)}</span>
                <Show when={props.showBytes()}>
                  <div class={`hex-row-cells cells-${props.bytesPerRow()}`}>
                    <Index each={row().bytes as unknown as readonly number[]}>
                      {(byte, colIdx) => (
                        <HexCell
                          addr={(row().addr + colIdx) & 0xffff}
                          byte={byte()}
                          isWatch={isRowWatch() && colIdx === watchOffset()}
                          paused={props.paused}
                          setByte={props.setByte}
                          advance={(a) => advance("hex", a)}
                        />
                      )}
                    </Index>
                  </div>
                </Show>
                <Show when={props.showAscii()}>
                  <div class={`hex-row-ascii cells-${props.bytesPerRow()}`}>
                    <Index each={row().bytes as unknown as readonly number[]}>
                      {(byte, colIdx) => (
                        <AsciiCell
                          addr={(row().addr + colIdx) & 0xffff}
                          byte={byte()}
                          isWatch={isRowWatch() && colIdx === watchOffset()}
                          paused={props.paused}
                          setByte={props.setByte}
                          advance={(a) => advance("ascii", a)}
                        />
                      )}
                    </Index>
                  </div>
                </Show>
              </div>
            );
          }}
        </Index>
      </div>
    </div>
  );
};
