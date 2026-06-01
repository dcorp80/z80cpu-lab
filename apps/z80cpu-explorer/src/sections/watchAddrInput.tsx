// Watch-address input for the Memory and IO sections. Local edit state
// kept in component scope so transient typos don't churn the store;
// commit semantics:
//   - Enter:  validate + setWatchAddr + requestJump (re-centers row).
//   - blur:   validate + setWatchAddr (no jump — clicking out of the
//             field shouldn't yank the user's scroll position).
//   - Escape: revert local text + blur, no commit.
// On rejected input the input snaps back to the current watch addr's
// hex form so the user always sees a parseable value when not focused.

import {
  type Accessor,
  type Component,
  createEffect,
  createSignal,
} from "solid-js";
import { filterHexInput, formatHex, parseAddr16 } from "../util/hex.ts";

export interface WatchAddrInputProps {
  watchAddr: Accessor<number>;
  setWatchAddr: (addr: number) => void;
  requestJump: () => void;
  label: string;
  tooltip: string;
  ariaLabel: string;
}

export const WatchAddrInput: Component<WatchAddrInputProps> = (props) => {
  let inputEl: HTMLInputElement | undefined;
  const [text, setText] = createSignal(formatHex(props.watchAddr(), 4));

  // External updates to watchAddr (e.g. another section action) refresh
  // the input — but only when the user isn't actively editing. Without
  // the focus guard, typing would be clobbered on each keystroke that
  // bumps the version.
  createEffect(() => {
    const wa = props.watchAddr();
    if (inputEl && document.activeElement === inputEl) return;
    setText(formatHex(wa, 4));
  });

  const commit = (jump: boolean): void => {
    const parsed = parseAddr16(text());
    if (parsed === null) {
      // Revert local state on parse failure — the user sees their bad
      // input snap back to the last good value.
      setText(formatHex(props.watchAddr(), 4));
      return;
    }
    props.setWatchAddr(parsed);
    if (jump) props.requestJump();
    // Normalize the displayed text to canonical bare-hex form.
    setText(formatHex(parsed, 4));
  };

  return (
    <label class="watch-input">
      <span class="watch-input-label">{props.label}</span>
      <input
        ref={(el) => {
          inputEl = el;
        }}
        type="text"
        class="watch-input-field"
        aria-label={props.ariaLabel}
        title={props.tooltip}
        value={text()}
        maxLength={6}
        onInput={(e) => setText(filterHexInput(e.currentTarget.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(true);
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setText(formatHex(props.watchAddr(), 4));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={() => commit(false)}
      />
    </label>
  );
};
