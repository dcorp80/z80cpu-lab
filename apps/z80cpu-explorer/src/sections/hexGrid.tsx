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
//
// Rapid entry (Enter advances to the next cell): on a successful Enter
// commit the cell calls `advance(addr, lane)` which (a) bumps watchAddr
// by one row when the current cell is at the bottom edge of the window
// and (b) DOM-clicks the next cell's button so it opens its editor.
// Hex and ASCII columns are independent advance lanes. Invalid Enter
// reverts the local text and KEEPS the cell focused so the user can
// immediately retype (REQ §6.6 rapid-entry rules).

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
import { formatHex } from "../util/hex.ts";
import { HexCell } from "./hexCell.tsx";

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
  /** Used by the rapid-entry advance to scroll the watch window forward
   *  one row when Enter happens on the last cell of the bottom row. */
  setWatchAddr: (addr: number) => void;
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
  let gridEl: HTMLDivElement | undefined;

  // Subscribe to the jump event; queueMicrotask lets the row layout
  // settle (relevant after a watchAddr change repositioned the row)
  // before we attempt to scroll. Skip the initial run — createEffect
  // fires once at subscription time, which on app boot (especially
  // post-Cold-boot reload) would scroll the whole page down into the
  // Memory section even though the user never requested a jump. The
  // prev-undefined seed pattern matches HexAddrInput's resetSignal
  // handling — first invocation only captures the baseline value.
  createEffect((prev: number | undefined) => {
    const v = props.jumpVersion();
    if (prev !== undefined) {
      queueMicrotask(() => {
        watchRowEl?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
    return v;
  }, undefined);

  /** Last visible address in the current window. Used to detect when an
   *  advance would fall off the bottom and the window needs to scroll. */
  const windowLastAddr = (): number => {
    const bpr = props.bytesPerRow;
    const alignMask = 0xffff & ~(bpr - 1);
    const wa = props.watchAddr() & 0xffff;
    const watchRowAddr = wa & alignMask;
    const start = (watchRowAddr - props.rowsBefore * bpr) & 0xffff;
    const count = props.rowsBefore + 1 + props.rowsAfter;
    return (start + count * bpr - 1) & 0xffff;
  };

  /** Common advance handler — called by both HexCell and AsciiCell on
   *  a successful Enter commit. Wrap-around at 0xFFFF is intentional:
   *  next wraps to 0x0000 and the watchAddr bump also wraps, so the
   *  user keeps editing into the bottom of address space without a
   *  special-case stop. */
  const advance = (lane: Lane, currentAddr: number): void => {
    const next = (currentAddr + 1) & 0xffff;
    if (currentAddr === windowLastAddr()) {
      // Bump the watch addr by one row so the next cell is visible.
      // Per REQ §6.6 the watch row highlight follows the entry point;
      // a separate edit-cursor distinct from watchAddr is an option if
      // this feels wrong in practice.
      props.setWatchAddr((props.watchAddr() + props.bytesPerRow) & 0xffff);
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

  return (
    <div
      class="hex-grid"
      ref={(el) => {
        gridEl = el;
      }}
    >
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
                      advance={(a) => advance("hex", a)}
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
  );
};
