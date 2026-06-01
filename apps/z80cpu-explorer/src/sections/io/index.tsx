import type { Component } from "solid-js";
import {
  DEFAULT_IO_ROWS_AFTER,
  DEFAULT_IO_ROWS_BEFORE,
} from "../../config/defaults.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { BytesPerRowSelect } from "../bytesPerRowSelect.tsx";
import { HexGrid } from "../hexGrid.tsx";
import type { SectionModule } from "../types.ts";
import { WatchAddrInput } from "../watchAddrInput.tsx";

const Header: Component = () => {
  const store = useStore();
  return (
    <>
      <WatchAddrInput
        watchAddr={store.ioWatchAddr}
        setWatchAddr={(a) => store.setIoWatchAddr(a)}
        requestJump={() => store.requestIoWatchJump()}
        label={STR.io.watchLabel}
        tooltip={STR.io.watchTooltip}
        ariaLabel={STR.io.watchAriaLabel}
      />
      <BytesPerRowSelect
        value={store.ioBytesPerRow}
        setValue={(n) => store.setIoBytesPerRow(n)}
      />
    </>
  );
};

const FoldedSummary: Component = () => {
  const store = useStore();
  const summary = () => {
    const parts: string[] = [
      STR.io.foldedHeader(formatHex(store.ioWatchAddr(), 4)),
    ];
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

const Body: Component = () => {
  const store = useStore();
  const paused = () => store.status() === "paused";
  return (
    <HexGrid
      read={(a) => store.ioByte(a)}
      version={store.ioVersion}
      setByte={(a, v) => store.setIoByte(a, v)}
      paused={paused}
      showAscii={false}
      watchAddr={store.ioWatchAddr}
      jumpVersion={store.ioWatchJumpVersion}
      rowsBefore={DEFAULT_IO_ROWS_BEFORE}
      rowsAfter={DEFAULT_IO_ROWS_AFTER}
      bytesPerRow={store.ioBytesPerRow()}
    />
  );
};

export const io: SectionModule = {
  id: "io",
  title: STR.io.title,
  Header,
  FoldedSummary,
  Body,
};
