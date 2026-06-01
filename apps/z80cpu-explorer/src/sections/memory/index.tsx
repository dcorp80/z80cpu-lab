import type { Component } from "solid-js";
import {
  DEFAULT_MEMORY_ROWS_AFTER,
  DEFAULT_MEMORY_ROWS_BEFORE,
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
        watchAddr={store.memWatchAddr}
        setWatchAddr={(a) => store.setMemWatchAddr(a)}
        requestJump={() => store.requestMemWatchJump()}
        label={STR.memory.watchLabel}
        tooltip={STR.memory.watchTooltip}
        ariaLabel={STR.memory.watchAriaLabel}
      />
      <BytesPerRowSelect
        value={store.memBytesPerRow}
        setValue={(n) => store.setMemBytesPerRow(n)}
      />
    </>
  );
};

const FoldedSummary: Component = () => {
  const store = useStore();
  const summary = () => {
    const parts: string[] = [
      STR.memory.foldedHeader(formatHex(store.memWatchAddr(), 4)),
    ];
    const w = store.lastMemWrite();
    const r = store.lastMemRead();
    if (w) {
      parts.push(
        STR.memory.foldedLastWrite(formatHex(w.addr, 4), formatHex(w.value, 2)),
      );
    }
    if (r) {
      parts.push(STR.memory.foldedLastRead(formatHex(r.addr, 4)));
    }
    if (!w && !r) parts.push(STR.memory.foldedNoActivity);
    return parts.join(" · ");
  };
  return <span class="muted">{summary()}</span>;
};

const Body: Component = () => {
  const store = useStore();
  const paused = () => store.status() === "paused";
  return (
    <HexGrid
      read={(a) => store.memByte(a)}
      version={store.memVersion}
      setByte={(a, v) => store.setMemByte(a, v)}
      paused={paused}
      showAscii={true}
      watchAddr={store.memWatchAddr}
      jumpVersion={store.memWatchJumpVersion}
      rowsBefore={DEFAULT_MEMORY_ROWS_BEFORE}
      rowsAfter={DEFAULT_MEMORY_ROWS_AFTER}
      bytesPerRow={store.memBytesPerRow()}
    />
  );
};

export const memory: SectionModule = {
  id: "memory",
  title: STR.memory.title,
  Header,
  FoldedSummary,
  Body,
};
