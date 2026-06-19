import { type Component, Show } from "solid-js";
import {
  DEFAULT_IO_VIEWPORT_ROWS,
  IO_BYTES_PER_ROW_OPTIONS,
} from "../../config/defaults.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { BytesPerRowSelect } from "../bytesPerRowSelect.tsx";
import { HexGrid } from "../hexGrid.tsx";
import { PageNavRow } from "../pageNavRow.tsx";
import type { SectionModule } from "../types.ts";
import { WatchAddrInput } from "../watchAddrInput.tsx";
import { IoPortGrid } from "./portGrid.tsx";

const ViewModeToggle: Component = () => {
  const store = useStore();
  return (
    <label class="io-viewmode" title={STR.io.viewModeTooltip}>
      <span class="io-viewmode-label">{STR.io.viewModeLabel}</span>
      <select
        class="io-viewmode-select"
        aria-label={STR.io.viewModeAriaLabel}
        value={store.ioViewMode()}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === "16bit" || v === "8bit") store.setIoViewMode(v);
        }}
      >
        <option value="16bit">{STR.io.viewMode16b}</option>
        <option value="8bit">{STR.io.viewMode8b}</option>
      </select>
    </label>
  );
};

const Header: Component = () => {
  const store = useStore();
  // The watch input is present in both modes; in 8-bit it shrinks to
  // 2 hex digits and rejects values > 0xFF. BPR also works in both
  // (16/32/64 → 16/8/4 rows for the 256-port window).
  // Split RD/WR was moved to the App-shell section since
  // toggling it requires a Cold boot; this header only exposes
  // per-port display controls.
  const padTo = () => (store.ioViewMode() === "8bit" ? 2 : 4);
  const maxValue = () => (store.ioViewMode() === "8bit" ? 0xff : 0xffff);
  const split = () => store.splitIo();
  // setIoWatchAddr / setIoWatchAddrWrite auto-sync viewPageBase (see
  // store/index.ts), so the watch inputs commit straight through.
  // Recall reverses navigation: jump view back to where the marker
  // lives, then bump the matching jumpVersion so the body scroll-
  // centers it.
  const recallReadToWatch = (): void => {
    store.setIoViewPageBase(store.ioWatchAddr());
    store.requestIoWatchJump();
  };
  const recallWriteToWatch = (): void => {
    store.setIoViewPageBaseWrite(store.ioWatchAddrWrite());
    store.requestIoWatchJumpWrite();
  };
  return (
    <>
      <ViewModeToggle />
      <WatchAddrInput
        watchAddr={store.ioWatchAddr}
        setWatchAddr={(a) => store.setIoWatchAddr(a)}
        requestJump={() => store.requestIoWatchJump()}
        label={split() ? STR.io.watchLabelRd : STR.io.watchLabel}
        tooltip={STR.io.watchTooltip}
        ariaLabel={split() ? STR.io.watchAriaLabelRd : STR.io.watchAriaLabel}
        padTo={padTo()}
        maxValue={maxValue()}
        recall={{
          // 8-bit mode renders all 256 ports — paging is a no-op,
          // recall is meaningless. Force-hide there regardless of
          // whatever ioWatchOnView was left at by the 16-bit pane.
          onView: () => store.ioViewMode() === "8bit" || store.ioWatchOnView(),
          onClick: recallReadToWatch,
          tooltip: STR.io.recallTooltip,
          ariaLabel: split()
            ? STR.io.recallAriaLabelRd
            : STR.io.recallAriaLabel,
        }}
      />
      <Show when={split()}>
        <WatchAddrInput
          watchAddr={store.ioWatchAddrWrite}
          setWatchAddr={(a) => store.setIoWatchAddrWrite(a)}
          requestJump={() => store.requestIoWatchJumpWrite()}
          label={STR.io.watchLabelWr}
          tooltip={STR.io.watchTooltip}
          ariaLabel={STR.io.watchAriaLabelWr}
          padTo={padTo()}
          maxValue={maxValue()}
          recall={{
            onView: () =>
              store.ioViewMode() === "8bit" || store.ioWatchOnViewWrite(),
            onClick: recallWriteToWatch,
            tooltip: STR.io.recallTooltip,
            ariaLabel: STR.io.recallAriaLabelWr,
          }}
        />
      </Show>
      <BytesPerRowSelect
        value={store.ioBytesPerRow}
        setValue={(n) => store.setIoBytesPerRow(n)}
        options={IO_BYTES_PER_ROW_OPTIONS}
      />
    </>
  );
};

const FoldedSummary: Component = () => {
  const store = useStore();
  const summary = () => {
    const mode = store.ioViewMode();
    const split = store.splitIo();
    const padTo = mode === "8bit" ? 2 : 4;
    const watchRd = formatHex(
      store.ioWatchAddr() & (mode === "8bit" ? 0xff : 0xffff),
      padTo,
    );
    const parts: string[] = [];
    if (split) {
      const watchWr = formatHex(
        store.ioWatchAddrWrite() & (mode === "8bit" ? 0xff : 0xffff),
        padTo,
      );
      parts.push(
        mode === "8bit"
          ? STR.io.foldedHeaderSplit8b(watchRd, watchWr)
          : STR.io.foldedHeaderSplit(watchRd, watchWr),
      );
    } else {
      parts.push(
        mode === "8bit"
          ? STR.io.foldedHeader8b(watchRd)
          : STR.io.foldedHeader(watchRd),
      );
    }
    const w = store.lastIoWrite();
    const r = store.lastIoRead();
    if (w) {
      parts.push(
        STR.io.foldedLastOut(formatHex(w.addr, 4), formatHex(w.value, 2)),
      );
    }
    if (r) {
      parts.push(
        STR.io.foldedLastIn(formatHex(r.addr, 4), formatHex(r.value, 2)),
      );
    }
    if (!w && !r) parts.push(STR.io.foldedNoActivity);
    return parts.join(" · ");
  };
  return <span class="muted">{summary()}</span>;
};

// Module-scope sentinels for the WR pane's no-op verbs. Kept stable
// across renders so HexGrid/IoPortGrid don't see new identities.
const neverPaused = (): boolean => false;
const noopSetByte = (_addr: number, _value: number): void => {};

type Plane = "read" | "write";

interface PlaneOps {
  read: (addr: number) => number;
  version: () => number;
  setByte: (addr: number, value: number) => void;
  setByte8: (port: number, value: number) => void;
  paused: () => boolean;
  watchAddr: () => number;
  setWatchAddr: (addr: number) => void;
  jumpVersion: () => number;
  viewPageBase: () => number;
  setViewPageBase: (addr: number) => void;
  setWatchOnView: (visible: boolean) => void;
  readOnly: boolean;
}

// Single resolution point for every per-plane prop the panes need.
// Collapses what was seven ternaries per Pane into one branch.
const planeOps = (
  plane: Plane,
  store: ReturnType<typeof useStore>,
): PlaneOps =>
  plane === "read"
    ? {
        read: (a) => store.ioByte(a),
        version: store.ioVersion,
        setByte: (a, v) => store.setIoByte(a, v),
        setByte8: (p, v) => store.setIoBytePort8(p, v),
        paused: () => store.status() === "paused",
        watchAddr: store.ioWatchAddr,
        setWatchAddr: (a) => store.setIoWatchAddr(a),
        jumpVersion: store.ioWatchJumpVersion,
        viewPageBase: store.ioViewPageBase,
        setViewPageBase: (a) => store.setIoViewPageBase(a),
        setWatchOnView: store.setIoWatchOnView,
        readOnly: false,
      }
    : {
        read: (a) => store.ioByteWrite(a),
        version: store.ioVersionWrite,
        setByte: noopSetByte,
        setByte8: noopSetByte,
        paused: neverPaused,
        watchAddr: store.ioWatchAddrWrite,
        setWatchAddr: (a) => store.setIoWatchAddrWrite(a),
        jumpVersion: store.ioWatchJumpVersionWrite,
        viewPageBase: store.ioViewPageBaseWrite,
        setViewPageBase: (a) => store.setIoViewPageBaseWrite(a),
        setWatchOnView: store.setIoWatchOnViewWrite,
        readOnly: true,
      };

const Pane16Bit: Component<{ plane: Plane }> = (props) => {
  const store = useStore();
  const ops = planeOps(props.plane, store);
  // Page-nav clicks move only the view; the watch stays put. If the
  // user has navigated away from the watch, the header's recall
  // button appears.
  const pageJump = (addr: number): void => {
    ops.setViewPageBase(addr);
  };
  return (
    <div
      class="hex-section-body hex-section-body-io"
      style={{ "--hex-grid-visible-rows": DEFAULT_IO_VIEWPORT_ROWS }}
    >
      <PageNavRow
        addr={ops.viewPageBase}
        pageSize={store.ioPageSize}
        setAddr={pageJump}
      />
      <HexGrid
        read={ops.read}
        version={ops.version}
        setByte={ops.setByte}
        paused={ops.paused}
        showBytes={() => true}
        showAscii={() => false}
        watchAddr={ops.watchAddr}
        setWatchAddr={ops.setWatchAddr}
        jumpVersion={ops.jumpVersion}
        pageSize={store.ioPageSize}
        viewPageBase={ops.viewPageBase}
        bytesPerRow={store.ioBytesPerRow}
        setWatchOnView={ops.setWatchOnView}
      />
    </div>
  );
};

const Pane8Bit: Component<{ plane: Plane }> = (props) => {
  const store = useStore();
  const ops = planeOps(props.plane, store);
  // Wrap in the same body class as Pane16Bit so `--hex-grid-visible-rows`
  // propagates and the grid clamps to the configured viewport — without
  // this the `.hex-grid` falls back to 24 rows and the 16-row 8-bit
  // grid mounts without ever needing to scroll. No PageNavRow here:
  // 256 ports fits in one page of any size, paging would be a no-op.
  return (
    <div
      class="hex-section-body hex-section-body-io"
      style={{ "--hex-grid-visible-rows": DEFAULT_IO_VIEWPORT_ROWS }}
    >
      <IoPortGrid
        paused={ops.paused}
        bytesPerRow={store.ioBytesPerRow}
        read={ops.read}
        version={ops.version}
        watchAddr={ops.watchAddr}
        setWatchAddr={ops.setWatchAddr}
        jumpVersion={ops.jumpVersion}
        setByte={ops.setByte8}
        readOnly={ops.readOnly}
      />
    </div>
  );
};

const Body: Component = () => {
  const store = useStore();
  // <Show> for reactive branching — a JSX ternary would read the mode
  // signal once at setup and not re-evaluate on toggle.
  const PaneByMode: Component<{ plane: "read" | "write" }> = (paneProps) => (
    <Show
      when={store.ioViewMode() === "8bit"}
      fallback={<Pane16Bit plane={paneProps.plane} />}
    >
      <Pane8Bit plane={paneProps.plane} />
    </Show>
  );
  return (
    <Show when={store.splitIo()} fallback={<PaneByMode plane="read" />}>
      <div class="io-split-body">
        <div class="io-pane" classList={{ "io-pane-rd": true }}>
          <div class="io-pane-title">{STR.io.paneTitleRd}</div>
          <PaneByMode plane="read" />
        </div>
        <div class="io-pane" classList={{ "io-pane-wr": true }}>
          <div class="io-pane-title">{STR.io.paneTitleWr}</div>
          <PaneByMode plane="write" />
        </div>
      </div>
    </Show>
  );
};

export const io: SectionModule = {
  id: "io",
  title: STR.io.title,
  Header,
  FoldedSummary,
  Body,
};
