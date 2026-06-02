import { type Component, Show } from "solid-js";
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

const WriteProtectToggle: Component = () => {
  const store = useStore();
  // Paused-only — toggling WP mid-run has confusing semantics (writes
  // landing mid-stream); the visible state lets the user know they need
  // to pause first to change the policy.
  const paused = () => store.status() === "paused";
  return (
    <label
      class="io-wp"
      classList={{ "is-disabled": !paused() }}
      title={STR.io.writeProtectTooltip}
    >
      <input
        type="checkbox"
        class="io-wp-checkbox"
        aria-label={STR.io.writeProtectAriaLabel}
        checked={store.ioWriteProtect()}
        disabled={!paused()}
        onChange={(e) => store.setIoWriteProtect(e.currentTarget.checked)}
      />
      <span class="io-wp-label">{STR.io.writeProtectLabel}</span>
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
  return (
    <>
      <ViewModeToggle />
      <WriteProtectToggle />
      <WatchAddrInput
        watchAddr={store.ioWatchAddr}
        setWatchAddr={(a) => store.setIoWatchAddr(a)}
        requestJump={() => store.requestIoWatchJump()}
        label={STR.io.watchLabel}
        tooltip={STR.io.watchTooltip}
        ariaLabel={STR.io.watchAriaLabel}
        padTo={padTo()}
        maxValue={maxValue()}
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
    const mode = store.ioViewMode();
    const padTo = mode === "8bit" ? 2 : 4;
    const watch = formatHex(
      store.ioWatchAddr() & (mode === "8bit" ? 0xff : 0xffff),
      padTo,
    );
    const parts: string[] = [
      mode === "8bit"
        ? STR.io.foldedHeader8b(watch)
        : STR.io.foldedHeader(watch),
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
  // <Show> for reactive branching — a JSX ternary would read
  // ioViewMode() once at setup and not re-evaluate on toggle.
  return (
    <Show
      when={store.ioViewMode() === "8bit"}
      fallback={
        <HexGrid
          read={(a) => store.ioByte(a)}
          version={store.ioVersion}
          setByte={(a, v) => store.setIoByte(a, v)}
          paused={paused}
          showAscii={false}
          watchAddr={store.ioWatchAddr}
          setWatchAddr={(a) => store.setIoWatchAddr(a)}
          jumpVersion={store.ioWatchJumpVersion}
          rowsBefore={DEFAULT_IO_ROWS_BEFORE}
          rowsAfter={DEFAULT_IO_ROWS_AFTER}
          bytesPerRow={store.ioBytesPerRow()}
        />
      }
    >
      <IoPortGrid
        paused={paused}
        rowsBefore={DEFAULT_IO_ROWS_BEFORE}
        rowsAfter={DEFAULT_IO_ROWS_AFTER}
      />
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
