// 8-bit-decoded IO view. Structurally similar to HexGrid but
// for the 256-port address space:
//   - Renders ALL 256 ports as `256 / bytesPerRow` rows. The grid is
//     fully scrollable through the viewport; no pagination (256 ports
//     fits in any of `PAGE_SIZE_OPTIONS`, so paging buttons would
//     always be no-ops here). No virtualization either — 256 ports is
//     small enough to mount everything cheaply.
//   - Row addr column shows 2 hex digits.
//   - Cells use HexCell with addrPadTo=2 so data-addr matches the
//     advance lookup.
//   - The user-selected watch port gets the standard `.is-watch-cell` /
//     `.is-watch-row` highlighting; the watch input in the IO header
//     accepts 0..0xFF and (on Enter) bumps the jump-version which
//     scrolls the watch row into view.
//   - bytesPerRow (16 / 32 / 64) drives row count (16 / 8 / 4) and
//     cells per row (16 / 32 / 64).
//   - The displayed byte for each port is read[port] (upper byte = 0).
//     When the 256 high-byte aliases for a port disagree (which can
//     happen if a CPU run with a 16-bit-decoded program wrote
//     different bytes to different aliases), the cell gets a
//     `.is-alias-mismatch` cue.
//   - Editing a port calls setByte which is expected to broadcast the
//     byte to all 256 aliases (the RD-plane store action does this).
//     The WR plane (split-IO mode) doesn't broadcast — its
//     contents are written by CPU OUT cycles, not user edits — and so
//     the section passes a never-paused accessor + no-op setter to
//     render the pane as a passive view.
//   - Rapid-entry advance wraps 0xFF → 0x00; the next cell's
//     `.focus()` naturally scrolls it into view if it was off-screen.

import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  Index,
} from "solid-js";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { HexCell } from "../hexCell.tsx";

export interface IoPortGridProps {
  /** Paused gate threaded down to HexCell — edits are paused-only. WR
   *  pane passes `() => false` so cells never enter edit mode. */
  paused: Accessor<boolean>;
  /** Bytes per row — 16/32/64. Drives row count (256 / bytesPerRow). */
  bytesPerRow: Accessor<number>;
  /** Read a byte at a 16-bit address — reused for the 256-alias
   *  mismatch scan as well as the displayed cell byte. */
  read: (addr: number) => number;
  /** Version signal — subscribing inside the memo couples re-renders
   *  to real byte changes rather than `read` reference identity. */
  version: Accessor<number>;
  /** Watch port (0..0xFF stored in a 16-bit field; we mask). */
  watchAddr: Accessor<number>;
  setWatchAddr: (port: number) => void;
  jumpVersion: Accessor<number>;
  /** Broadcast-edit verb. For the RD plane this is store.setIoBytePort8;
   *  for the WR plane the section passes a no-op (cells are never
   *  editable anyway, but HexCell requires the prop). */
  setByte: (port: number, value: number) => void;
  /** When true the pane is a passive view (WR plane in split mode).
   *  Drops the "Editing rewrites all 256 aliases" clause from the
   *  alias-mismatch tooltip, which is misleading on a read-only view. */
  readOnly?: boolean;
}

interface PortCellModel {
  port: number;
  value: number;
  aliasMismatch: boolean;
}

interface PortRowModel {
  startPort: number;
  cells: PortCellModel[];
}

export const IoPortGrid: Component<IoPortGridProps> = (props) => {
  // Bytes + alias-mismatch only. NOT subscribed to watchAddr — moving
  // the watch port doesn't trigger the 256×256 = 65 K alias-mismatch
  // scan. Watch state lives in cheap memos below; JSX folds them in
  // per row / per cell.
  const rows = createMemo<PortRowModel[]>(() => {
    props.version();
    const w = props.bytesPerRow();
    const rowCount = 256 / w;
    const out: PortRowModel[] = new Array(rowCount);
    for (let r = 0; r < rowCount; r++) {
      const rowStart = r * w;
      const cells: PortCellModel[] = new Array(w);
      for (let c = 0; c < w; c++) {
        const port = (rowStart + c) & 0xff;
        const v = props.read(port);
        let mismatch = false;
        for (let hi = 1; hi < 256; hi++) {
          if (props.read((hi << 8) | port) !== v) {
            mismatch = true;
            break;
          }
        }
        cells[c] = { port, value: v, aliasMismatch: mismatch };
      }
      out[r] = { startPort: rowStart, cells };
    }
    return out;
  });

  const watchPort = createMemo(() => props.watchAddr() & 0xff);

  let gridEl: HTMLDivElement | undefined;

  // Jump effect — Enter on the watch input bumps jumpVersion; find the
  // (now possibly different) watch row by selector and scroll it into
  // view. No captured DOM ref needed — `<Index>` reuses row elements
  // across mounts, so a ref captured on first mount may not point at
  // the current watch row after a watchAddr change. Skip the initial
  // run so a fresh boot doesn't scroll the page down.
  createEffect((prev: number | undefined) => {
    const v = props.jumpVersion();
    if (prev !== undefined) {
      queueMicrotask(() => {
        const watchRow = gridEl?.querySelector(".hex-row.is-watch-row");
        watchRow?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
    return v;
  }, undefined);

  // Rapid-entry advance: just step to the next port. Wrap 0xFF → 0x00.
  // No watchAddr bump (the whole 8-bit space is mounted) — the next
  // cell's input gets focus, which auto-scrolls it into view if it was
  // outside the viewport.
  const advance = (currentPort: number): void => {
    const next = (currentPort + 1) & 0xff;
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
          const w = () => props.bytesPerRow();
          const isRowWatch = createMemo(
            () =>
              watchPort() >= row().startPort &&
              watchPort() < row().startPort + w(),
          );
          return (
            <div class="hex-row" classList={{ "is-watch-row": isRowWatch() }}>
              <span class="hex-row-addr">{formatHex(row().startPort, 2)}</span>
              <div class={`hex-row-cells cells-${w()}`}>
                <Index each={row().cells}>
                  {(cell, colIdx) => (
                    <HexCell
                      addr={cell().port}
                      byte={cell().value}
                      isWatch={
                        isRowWatch() && watchPort() - row().startPort === colIdx
                      }
                      paused={props.paused}
                      setByte={(p, v) => props.setByte(p, v)}
                      advance={advance}
                      addrPadTo={2}
                      extraClassList={{
                        "is-alias-mismatch": cell().aliasMismatch,
                      }}
                      title={
                        cell().aliasMismatch
                          ? props.readOnly
                            ? STR.io.aliasMismatchTooltipReadOnly(
                                formatHex(cell().port, 2),
                              )
                            : STR.io.aliasMismatchTooltip(
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
