import { type Component, Show } from "solid-js";
import {
  DEFAULT_IO_ROWS_AFTER,
  DEFAULT_IO_ROWS_BEFORE,
  IO_BYTES_PER_ROW_OPTIONS,
} from "../../config/defaults.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { BytesPerRowSelect } from "../bytesPerRowSelect.tsx";
import { HexGrid } from "../hexGrid.tsx";
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

const SplitIoToggle: Component = () => {
  const store = useStore();
  // Paused-only — toggling reloads the page (REQ §11), so doing it
  // mid-run would kill the run anyway; gating on `paused` matches
  // the Reinit button's policy and avoids accidental clicks during
  // a long run.
  const paused = () => store.status() === "paused";
  return (
    <label
      class="io-split"
      classList={{ "is-disabled": !paused() }}
      title={STR.io.splitTooltip}
    >
      <input
        type="checkbox"
        class="io-split-checkbox"
        aria-label={STR.io.splitAriaLabel}
        checked={store.splitIo()}
        disabled={!paused()}
        onChange={(e) => store.setSplitIo(e.currentTarget.checked)}
      />
      <span class="io-split-label">{STR.io.splitLabel}</span>
    </label>
  );
};

const Header: Component = () => {
  const store = useStore();
  // The watch input is present in both modes; in 8-bit it shrinks to
  // 2 hex digits and rejects values > 0xFF. BPR also works in both
  // (16/32/64 → 16/8/4 rows for the 256-port window).
  const padTo = () => (store.ioViewMode() === "8bit" ? 2 : 4);
  const maxValue = () => (store.ioViewMode() === "8bit" ? 0xff : 0xffff);
  const split = () => store.splitIo();
  return (
    <>
      <ViewModeToggle />
      <SplitIoToggle />
      <WatchAddrInput
        watchAddr={store.ioWatchAddr}
        setWatchAddr={(a) => store.setIoWatchAddr(a)}
        requestJump={() => store.requestIoWatchJump()}
        label={split() ? STR.io.watchLabelRd : STR.io.watchLabel}
        tooltip={STR.io.watchTooltip}
        ariaLabel={split() ? STR.io.watchAriaLabelRd : STR.io.watchAriaLabel}
        padTo={padTo()}
        maxValue={maxValue()}
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
        readOnly: true,
      };

const Pane16Bit: Component<{ plane: Plane }> = (props) => {
  const store = useStore();
  const ops = planeOps(props.plane, store);
  return (
    <HexGrid
      read={ops.read}
      version={ops.version}
      setByte={ops.setByte}
      paused={ops.paused}
      showAscii={false}
      watchAddr={ops.watchAddr}
      setWatchAddr={ops.setWatchAddr}
      jumpVersion={ops.jumpVersion}
      rowsBefore={DEFAULT_IO_ROWS_BEFORE}
      rowsAfter={DEFAULT_IO_ROWS_AFTER}
      bytesPerRow={store.ioBytesPerRow()}
    />
  );
};

const Pane8Bit: Component<{ plane: Plane }> = (props) => {
  const store = useStore();
  const ops = planeOps(props.plane, store);
  return (
    <IoPortGrid
      paused={ops.paused}
      rowsBefore={DEFAULT_IO_ROWS_BEFORE}
      rowsAfter={DEFAULT_IO_ROWS_AFTER}
      bytesPerRow={store.ioBytesPerRow()}
      read={ops.read}
      version={ops.version}
      watchAddr={ops.watchAddr}
      setWatchAddr={ops.setWatchAddr}
      jumpVersion={ops.jumpVersion}
      setByte={ops.setByte8}
      readOnly={ops.readOnly}
    />
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
