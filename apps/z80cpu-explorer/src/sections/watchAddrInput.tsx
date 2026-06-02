// Watch-address input for the Memory and IO sections. Thin wrapper over
// the shared HexAddrInput that adds the section-header label chrome.
//
// Commit semantics live in HexAddrInput; the only section-specific bits
// here are the jump-on-Enter hook (re-centers the watch row) and the
// label/aria copy.

import { type Accessor, type Component, createUniqueId } from "solid-js";
import { HexAddrInput } from "./hexAddrInput.tsx";

export interface WatchAddrInputProps {
  watchAddr: Accessor<number>;
  setWatchAddr: (addr: number) => void;
  requestJump: () => void;
  label: string;
  tooltip: string;
  ariaLabel: string;
}

export const WatchAddrInput: Component<WatchAddrInputProps> = (props) => {
  // Per-instance id so clicking the visible label text focuses the
  // input. HexAddrInput's input lives behind the component boundary, so
  // we associate via `htmlFor` instead of nesting — Memory and IO both
  // render a WatchAddrInput on the same page, so the id must be unique.
  const inputId = createUniqueId();
  return (
    <div class="watch-input">
      <label class="watch-input-label" for={inputId}>
        {props.label}
      </label>
      <HexAddrInput
        id={inputId}
        class="watch-input-field"
        committed={props.watchAddr}
        commit={(v) => props.setWatchAddr(v)}
        onJumpAfterEnter={() => props.requestJump()}
        ariaLabel={props.ariaLabel}
        title={props.tooltip}
        maxLength={6}
      />
    </div>
  );
};
