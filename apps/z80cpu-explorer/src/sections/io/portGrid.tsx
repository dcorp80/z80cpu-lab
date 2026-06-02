// 8-bit-decoded IO view (REQ §6.7). Structurally a HexGrid clone for the
// 256-port address space:
//   - Renders a windowed view (rowsBefore + 1 + rowsAfter rows)
//     centred on the watchAddr, identical shape to the 16-bit IO and
//     Memory grids. Row indices wrap at 0xFF so the window stays
//     continuous near the address-space edge.
//   - Row addr column shows 2 hex digits.
//   - Cells use HexCell with addrPadTo=2 so data-addr matches the
//     advance lookup.
//   - The user-selected watch port gets the standard `.is-watch-cell` /
//     `.is-watch-row` highlighting; the watch input in the IO header
//     accepts 0..0xFF and (on Enter) bumps the jump-version which
//     scrolls the watch row into view.
//   - bytesPerRow (16 / 32 / 64) controls cells per row; the visible
//     row count stays at rowsBefore + 1 + rowsAfter regardless.
//   - The displayed byte for each port is io[port] (upper byte = 0).
//     When the 256 high-byte aliases for a port disagree (which can
//     happen if a CPU run with a 16-bit-decoded program wrote
//     different bytes to different aliases), the cell gets a
//     `.is-alias-mismatch` cue.
//   - Editing a port calls store.setIoBytePort8 which broadcasts the
//     byte to all 256 aliases. Rapid-entry advance wraps 0xFF → 0x00.

import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  Index,
} from "solid-js";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { HexCell } from "../hexCell.tsx";

export interface IoPortGridProps {
  /** Paused gate threaded down to HexCell — edits are paused-only. */
  paused: Accessor<boolean>;
  /** Rows above/below the watch row. Matches the HexGrid prop shape. */
  rowsBefore: number;
  rowsAfter: number;
}

interface PortCellModel {
  port: number;
  value: number;
  aliasMismatch: boolean;
}

interface PortRowModel {
  startPort: number;
  cells: PortCellModel[];
  isWatch: boolean;
  /** Index within `cells` of the watch port; -1 when this row isn't
   *  the watch row. */
  watchOffset: number;
}

export const IoPortGrid: Component<IoPortGridProps> = (props) => {
  const store = useStore();

  // Build only the visible window. For each visible cell we still scan
  // the 255 other high-byte aliases to detect mismatch; the cost is
  // (visible cells) × 256 reads, which at the default 3 rows × 16 bpr
  // is ~12K typed-array reads — cheap, and only runs at paused render
  // time.
  const rows = createMemo<PortRowModel[]>(() => {
    const w = store.ioBytesPerRow();
    const watchPort = store.ioWatchAddr() & 0xff;
    const rowAlignMask = 0xff & ~(w - 1);
    const watchRowStart = watchPort & rowAlignMask;
    // start at (watchRowStart - rowsBefore*bpr), wrapping in 8-bit space.
    const start = (watchRowStart - props.rowsBefore * w) & 0xff;
    const rowCount = props.rowsBefore + 1 + props.rowsAfter;
    const out: PortRowModel[] = [];
    for (let r = 0; r < rowCount; r++) {
      const rowStart = (start + r * w) & 0xff;
      const cells: PortCellModel[] = new Array(w);
      for (let c = 0; c < w; c++) {
        const port = (rowStart + c) & 0xff;
        const v = store.ioByte(port);
        let mismatch = false;
        for (let hi = 1; hi < 256; hi++) {
          if (store.ioByte((hi << 8) | port) !== v) {
            mismatch = true;
            break;
          }
        }
        cells[c] = { port, value: v, aliasMismatch: mismatch };
      }
      const isWatch = rowStart === watchRowStart;
      out.push({
        startPort: rowStart,
        cells,
        isWatch,
        watchOffset: isWatch ? watchPort - rowStart : -1,
      });
    }
    return out;
  });

  let gridEl: HTMLDivElement | undefined;
  let watchRowEl: HTMLDivElement | undefined;

  // Jump effect — mirrors HexGrid. The watch-jump version bumps on
  // Enter in the watch input; scroll the watch row into view even when
  // the watch port didn't change (user may have scrolled the page).
  createEffect(() => {
    store.ioWatchJumpVersion();
    queueMicrotask(() => {
      watchRowEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  });

  /** Last visible port in the current window — mirrors HexGrid's
   *  `windowLastAddr`. Used by advance to detect when the next cell
   *  would fall off the bottom row and the window needs to scroll. */
  const windowLastPort = (): number => {
    const w = store.ioBytesPerRow();
    const watchPort = store.ioWatchAddr() & 0xff;
    const rowAlignMask = 0xff & ~(w - 1);
    const watchRowStart = watchPort & rowAlignMask;
    const start = (watchRowStart - props.rowsBefore * w) & 0xff;
    const rowCount = props.rowsBefore + 1 + props.rowsAfter;
    return (start + rowCount * w - 1) & 0xff;
  };

  // Mirrors HexGrid: when the just-edited port is at the bottom edge of
  // the visible window, bump watchAddr by one row so the next cell is
  // visible. Wrap-around at 0xFF is intentional — the watchAddr bump
  // wraps in 8-bit space, so rapid-entry keeps flowing across the
  // address-space edge without a special case.
  const advance = (currentPort: number): void => {
    const next = (currentPort + 1) & 0xff;
    if (currentPort === windowLastPort()) {
      store.setIoWatchAddr(
        (store.ioWatchAddr() + store.ioBytesPerRow()) & 0xff,
      );
    }
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (!gridEl) return;
        const el = gridEl.querySelector(
          `.hex-cell[data-addr="${formatHex(next, 2)}"]`,
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
        {(row) => {
          const captureRef = (el: HTMLDivElement) => {
            if (row().isWatch) watchRowEl = el;
          };
          return (
            <div
              class="hex-row"
              classList={{ "is-watch-row": row().isWatch }}
              ref={captureRef}
            >
              <span class="hex-row-addr">{formatHex(row().startPort, 2)}</span>
              <div class={`hex-row-cells cells-${store.ioBytesPerRow()}`}>
                <Index each={row().cells}>
                  {(cell, colIdx) => (
                    <HexCell
                      addr={cell().port}
                      byte={cell().value}
                      isWatch={row().watchOffset === colIdx}
                      paused={props.paused}
                      setByte={(p, v) => store.setIoBytePort8(p, v)}
                      advance={advance}
                      addrPadTo={2}
                      extraClassList={{
                        "is-alias-mismatch": cell().aliasMismatch,
                      }}
                      title={
                        cell().aliasMismatch
                          ? STR.io.aliasMismatchTooltip(
                              formatHex(cell().port, 2),
                            )
                          : undefined
                      }
                    />
                  )}
                </Index>
              </div>
            </div>
          );
        }}
      </Index>
    </div>
  );
};
