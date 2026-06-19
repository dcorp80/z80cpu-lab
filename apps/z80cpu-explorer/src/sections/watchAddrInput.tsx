// Watch-address input for the Memory and IO sections. Thin wrapper over
// the shared HexAddrInput that adds the section-header label chrome.
//
// Commit semantics live in HexAddrInput; the only section-specific bits
// here are the jump-on-Enter hook (re-centers the watch row), the
// label/aria copy, and the optional "recall watch" adornment that
// shows when navigation has carried the user away from the watched
// address.

import { type Accessor, type Component, createUniqueId, Show } from "solid-js";
import { formatHex } from "../util/hex.ts";
import { HexAddrInput } from "./hexAddrInput.tsx";

export interface WatchAddrInputRecall {
  /** True when the watched addr is currently in view. Button hides. */
  onView: Accessor<boolean>;
  /** Clicked → caller jumps view back to the watched addr + scrolls. */
  onClick: () => void;
  /** Localized tooltip — typically references the addr. */
  tooltip: string;
  ariaLabel: string;
}

export interface WatchAddrInputProps {
  watchAddr: Accessor<number>;
  setWatchAddr: (addr: number) => void;
  requestJump: () => void;
  label: string;
  tooltip: string;
  ariaLabel: string;
  /** Hex-digit display width (default 4). 2 for the IO 8-bit view. */
  padTo?: number;
  /** Inclusive max value (default 0xFFFF). 0xFF for the IO 8-bit view. */
  maxValue?: number;
  /** Optional recall button — rendered inline after the input when
   *  provided and `recall.onView()` is false. */
  recall?: WatchAddrInputRecall;
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
        padTo={props.padTo}
        maxValue={props.maxValue}
        maxLength={6}
      />
      <Show when={props.recall}>
        {(recall) => (
          <Show when={!recall().onView()}>
            <button
              type="button"
              class="watch-recall-btn"
              title={recall().tooltip}
              aria-label={recall().ariaLabel}
              onClick={() => recall().onClick()}
            >
              ↩ {formatHex(props.watchAddr(), props.padTo ?? 4)}
            </button>
          </Show>
        )}
      </Show>
    </div>
  );
};
