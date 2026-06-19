import type { Component } from "solid-js";
import {
  DEFAULT_MEMORY_VIEWPORT_ROWS,
  MEMORY_BYTES_PER_ROW_OPTIONS,
} from "../../config/defaults.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { BytesPerRowSelect } from "../bytesPerRowSelect.tsx";
import { HexGrid } from "../hexGrid.tsx";
import { PageNavRow } from "../pageNavRow.tsx";
import type { SectionModule } from "../types.ts";
import { WatchAddrInput } from "../watchAddrInput.tsx";

const Header: Component = () => {
  const store = useStore();
  // setMemWatchAddr auto-syncs viewPageBase (see store/index.ts), so
  // the watch input's commit goes straight through. The recall
  // button reverses navigation: jump view back to where the marker
  // lives, then bump jumpVersion so the body scroll-centers it.
  const recallToWatch = (): void => {
    store.setMemViewPageBase(store.memWatchAddr());
    store.requestMemWatchJump();
  };
  return (
    <>
      <WatchAddrInput
        watchAddr={store.memWatchAddr}
        setWatchAddr={(a) => store.setMemWatchAddr(a)}
        requestJump={() => store.requestMemWatchJump()}
        label={STR.memory.watchLabel}
        tooltip={STR.memory.watchTooltip}
        ariaLabel={STR.memory.watchAriaLabel}
        recall={{
          onView: store.memWatchOnView,
          onClick: recallToWatch,
          tooltip: STR.memory.recallTooltip,
          ariaLabel: STR.memory.recallAriaLabel,
        }}
      />
      <BytesPerRowSelect
        value={store.memBytesPerRow}
        setValue={(n) => store.setMemBytesPerRow(n)}
        options={MEMORY_BYTES_PER_ROW_OPTIONS}
      />
      <label class="header-checkbox">
        <input
          type="checkbox"
          checked={store.memShowBytes()}
          aria-label={STR.memory.showBytesAriaLabel}
          onChange={(e) => store.setMemShowBytes(e.currentTarget.checked)}
        />
        {STR.memory.showBytesLabel}
      </label>
      <label class="header-checkbox">
        <input
          type="checkbox"
          checked={store.memShowAscii()}
          aria-label={STR.memory.showAsciiAriaLabel}
          onChange={(e) => store.setMemShowAscii(e.currentTarget.checked)}
        />
        {STR.memory.showAsciiLabel}
      </label>
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
  // Page-nav clicks only move the view. Watch addr stays put; if the
  // user navigates away from the watch, the header's recall button
  // appears.
  const pageJump = (addr: number): void => {
    store.setMemViewPageBase(addr);
  };
  return (
    <div
      class="hex-section-body hex-section-body-mem"
      style={{ "--hex-grid-visible-rows": DEFAULT_MEMORY_VIEWPORT_ROWS }}
    >
      <PageNavRow
        addr={store.memViewPageBase}
        pageSize={store.memPageSize}
        setAddr={pageJump}
      />
      <HexGrid
        read={(a) => store.memByte(a)}
        version={store.memVersion}
        setByte={(a, v) => store.setMemByte(a, v)}
        paused={paused}
        showBytes={store.memShowBytes}
        showAscii={store.memShowAscii}
        watchAddr={store.memWatchAddr}
        setWatchAddr={(a) => store.setMemWatchAddr(a)}
        jumpVersion={store.memWatchJumpVersion}
        pageSize={store.memPageSize}
        viewPageBase={store.memViewPageBase}
        bytesPerRow={store.memBytesPerRow}
        setWatchOnView={store.setMemWatchOnView}
      />
    </div>
  );
};

export const memory: SectionModule = {
  id: "memory",
  title: STR.memory.title,
  Header,
  FoldedSummary,
  Body,
};
