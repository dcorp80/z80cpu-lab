// Shared hex grid (REQ §6.6 / §6.7). Renders a fixed window of rows
// centered on a user-typed watch address — no 64K virtualization, no
// PC tracking. Reused by the Memory and IO sections; ASCII column is
// the only structural difference (mem: on, io: off).
//
// Reactivity: a single createMemo at the grid level reads all visible
// bytes via the `read` accessor, gated on the matching version signal.
// Edits commit through `setByte` and bump that version; the memo
// re-runs and the grid updates. Per-cell edits are local input state;
// `paused()` gates the input — calls during run no-op anyway (store
// enforces the gate too).

import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  Index,
  Show,
} from "solid-js";
import { STR } from "../style/strings.ts";
import { filterHexInput, formatHex, parseHex } from "../util/hex.ts";

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
  /** Memory wants ASCII; IO does not (no character semantics on ports). */
  showAscii: boolean;
  watchAddr: Accessor<number>;
  /** Event signal — bumps on Enter from the watch input. Scrolls the
   *  watch row into view as a side effect. */
  jumpVersion: Accessor<number>;
  /** Caller picks the window size (no shared default — Memory and IO
   *  size independently; see config/defaults.ts). */
  rowsBefore: number;
  rowsAfter: number;
  /** Bytes per row — 16 / 32 / 64. Row base addresses align to this
   *  size (mask = ~(bpr - 1)) and the cell grid uses the matching
   *  `.cells-N` CSS class. */
  bytesPerRow: number;
}

interface RowModel {
  /** Row-aligned base address (mask = ~(bytesPerRow - 1)). */
  addr: number;
  bytes: number[];
  isWatch: boolean;
  /** Column within the row whose address equals watchAddr; -1 on
   *  non-watch rows. */
  watchOffset: number;
}

/** Printable-ASCII guard for the ASCII column. Z80 programs frequently
 *  store data with the high bit set or use 0..1F as token codes; both
 *  render as the configured placeholder so the column stays aligned. */
function asciiGlyph(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  return STR.hexGrid.nonPrintable;
}

interface HexCellProps {
  addr: number;
  byte: number;
  isWatch: boolean;
  paused: Accessor<boolean>;
  setByte: (addr: number, value: number) => void;
}

const HexCell: Component<HexCellProps> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");

  const commit = () => {
    const v = parseHex(text());
    if (v !== null && v >= 0 && v <= 0xff) {
      props.setByte(props.addr, v);
    }
    setEditing(false);
  };

  const beginEdit = () => {
    if (!props.paused()) return;
    setText(formatHex(props.byte, 2));
    setEditing(true);
  };

  return (
    <button
      type="button"
      class="hex-cell"
      classList={{
        "is-watch-cell": props.isWatch,
        "is-editable": props.paused(),
      }}
      // tabIndex={-1} keeps cells out of the natural tab order; full
      // grid keyboard nav (arrow keys, etc.) is post-MVP and the
      // section header's watch input is the keyboard entry point.
      tabIndex={-1}
      onClick={beginEdit}
    >
      <Show when={editing()} fallback={<span>{formatHex(props.byte, 2)}</span>}>
        <input
          type="text"
          class="hex-cell-input"
          aria-label={STR.hexGrid.cellEditAriaLabel(formatHex(props.addr, 4))}
          maxLength={2}
          value={text()}
          // Imperative focus on mount — the HTML `autofocus` attribute
          // only fires at document load, not when an element is
          // inserted dynamically. The button we just clicked still owns
          // focus when this input mounts; without this call the input
          // renders un-focused and the browser logs
          // "Autofocus processing was blocked because a document already
          //  has a focused element". `.select()` highlights the seeded
          // hex so the user can type-replace immediately.
          ref={(el) => {
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          onInput={(e) => setText(filterHexInput(e.currentTarget.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setEditing(false);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          onBlur={commit}
        />
      </Show>
    </button>
  );
};

interface AsciiCellProps {
  addr: number;
  byte: number;
  isWatch: boolean;
  paused: Accessor<boolean>;
  setByte: (addr: number, value: number) => void;
}

const AsciiCell: Component<AsciiCellProps> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");

  const commit = () => {
    const t = text();
    if (t.length > 0) {
      const code = t.charCodeAt(0);
      // Accept any 0..255 single-byte glyph the user typed. The ASCII
      // glyph mapping renders non-printables as `.` but the underlying
      // byte stays whatever the user committed (matches a hex editor).
      if (code >= 0 && code <= 0xff) {
        props.setByte(props.addr, code);
      }
    }
    setEditing(false);
  };

  const beginEdit = () => {
    if (!props.paused()) return;
    setText(asciiGlyph(props.byte));
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
      onClick={beginEdit}
    >
      <Show when={editing()} fallback={<span>{asciiGlyph(props.byte)}</span>}>
        <input
          type="text"
          class="hex-ascii-input"
          aria-label={STR.hexGrid.cellAsciiEditAriaLabel(
            formatHex(props.addr, 4),
          )}
          maxLength={1}
          value={text()}
          // See HexCell — imperative focus + select for the same reason.
          ref={(el) => {
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setEditing(false);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          onBlur={commit}
        />
      </Show>
    </button>
  );
};

export const HexGrid: Component<HexGridProps> = (props) => {
  // One memo drives the entire grid: subscribes to version + watchAddr
  // + props.read identity and emits the visible row set. Walking memory
  // top-to-bottom and recomputing on every version bump is fine —
  // worst case (Memory's 12 rows × 16 cells) is 192 reads, dominated
  // by the layout pass anyway.
  const rows = createMemo<RowModel[]>(() => {
    props.version();
    const bpr = props.bytesPerRow;
    const alignMask = 0xffff & ~(bpr - 1);
    const wa = props.watchAddr() & 0xffff;
    const watchRowAddr = wa & alignMask;
    const start = (watchRowAddr - props.rowsBefore * bpr) & 0xffff;
    const count = props.rowsBefore + 1 + props.rowsAfter;
    const out: RowModel[] = new Array(count);
    for (let r = 0; r < count; r++) {
      const rowAddr = (start + r * bpr) & 0xffff;
      const bytes: number[] = new Array(bpr);
      for (let c = 0; c < bpr; c++) {
        bytes[c] = props.read((rowAddr + c) & 0xffff);
      }
      const isWatch = rowAddr === watchRowAddr;
      out[r] = {
        addr: rowAddr,
        bytes,
        isWatch,
        watchOffset: isWatch ? wa & (bpr - 1) : -1,
      };
    }
    return out;
  });

  // Captured on mount of the row at index `rowsBefore` — that's the
  // watch row by construction. Re-mounts of `<Index>` keep the same
  // DOM element when length is stable, so this ref stays valid as
  // rows() re-runs.
  let watchRowEl: HTMLDivElement | undefined;

  createEffect(() => {
    // Subscribe to the jump event; queueMicrotask lets the row layout
    // settle (relevant after a watchAddr change repositioned the row)
    // before we attempt to scroll.
    props.jumpVersion();
    queueMicrotask(() => {
      watchRowEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  });

  return (
    <div class="hex-grid">
      <Index each={rows()}>
        {(row, idx) => {
          const captureRef = (el: HTMLDivElement) => {
            if (idx === props.rowsBefore) watchRowEl = el;
          };
          return (
            <div
              class="hex-row"
              classList={{ "is-watch-row": row().isWatch }}
              ref={captureRef}
            >
              <span class="hex-row-addr">{formatHex(row().addr, 4)}</span>
              <div class={`hex-row-cells cells-${props.bytesPerRow}`}>
                <Index each={row().bytes}>
                  {(byte, colIdx) => (
                    <HexCell
                      addr={(row().addr + colIdx) & 0xffff}
                      byte={byte()}
                      isWatch={row().watchOffset === colIdx}
                      paused={props.paused}
                      setByte={props.setByte}
                    />
                  )}
                </Index>
              </div>
              <Show when={props.showAscii}>
                <div class={`hex-row-ascii cells-${props.bytesPerRow}`}>
                  <Index each={row().bytes}>
                    {(byte, colIdx) => (
                      <AsciiCell
                        addr={(row().addr + colIdx) & 0xffff}
                        byte={byte()}
                        isWatch={row().watchOffset === colIdx}
                        paused={props.paused}
                        setByte={props.setByte}
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
  );
};
