// Shared hex-value input for address-style (and byte-style) fields.
//
// Behavior:
//   - on focus: text clears; an HTML placeholder of the current committed
//     value appears so the user sees what they're about to override.
//   - typing: local edit text only; no live commit.
//   - Enter on valid value: commit(); if onJumpAfterEnter is set, fire it;
//     blur (revert to canonical committed display).
//   - Enter on empty: blur (no commit, no change).
//   - Enter on parse-invalid OR commit-rejected: flash `.is-invalid`,
//     revert local text to empty (placeholder still visible), KEEP focus
//     so the user can immediately retype.
//   - blur on empty or invalid or rejected: silently revert (display
//     re-shows committed value).
//   - blur on valid+changed: commit(); if commit returns false, revert.
//   - Escape: revert local text + blur (no commit).
//
// `commit` may return `false` to reject (e.g., cross-field violation
// like BP lo > hi) — the component treats this exactly like parse-invalid.

import {
  type Accessor,
  type Component,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { formatHex, parseHex } from "../util/hex.ts";

export interface HexAddrInputProps {
  /** Reactive committed value. Renders when not focused; appears as the
   *  HTML placeholder when focused-and-empty. */
  committed: Accessor<number>;
  /** Pad width for display + placeholder. Default 4 (addresses); use 2
   *  for byte-sized fields (INT vector). */
  padTo?: number;
  /** Inclusive max value. Default 0xFFFF for addresses; pass 0xFF for
   *  byte fields. */
  maxValue?: number;
  /** Called with the parsed value on a successful commit attempt. Return
   *  `false` to reject (cross-field violation); the component treats this
   *  as invalid and reverts local text. Returning nothing (`void`) — the
   *  common case — counts as accepted. */
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` in the union lets void-returning handlers (the common case) satisfy the type while still allowing `false` to reject.
  commit: (value: number) => boolean | void;
  /** Optional hook called after a successful Enter commit. Memory/IO use
   *  this to fire the watch-jump request (scroll the row back into view). */
  onJumpAfterEnter?: () => void;
  /** Per-input disabled state (Program AddStub uses this while the
   *  picker is open). */
  disabled?: boolean;
  /** Extra class on the input element. Callers pass section-specific
   *  classes here (`.watch-input-field`, `.program-file-addr`, etc.). */
  class?: string;
  /** Extra classList entries (e.g. `is-dirty` from the Program row). The
   *  component adds its own `is-invalid` on top. */
  classList?: Record<string, boolean | undefined>;
  ariaLabel?: string;
  title?: string;
  size?: number;
  maxLength?: number;
  /** Forwarded to the inner `<input id=…>`. Lets a parent associate a
   *  real `<label htmlFor>` with the control — the nesting-based
   *  association doesn't survive the component boundary. */
  id?: string;
  /** Forward the input ref out (rapid-entry hex grid uses this to
   *  imperatively focus the next cell). */
  ref?: (el: HTMLInputElement) => void;
  /** Optional reset signal. Bumping the value forces the input to drop
   *  any local edit state (text cleared, focus state cleared). Used by
   *  Program AddStub to re-display the placeholder after a successful
   *  Add — the addr signal goes from 0 (typed-but-not-committed) back
   *  to 0 (after reset), so a value-change-based reset can't fire. */
  resetSignal?: Accessor<number>;
}

/** How long the `.is-invalid` flash stays on after a rejected commit
 *  attempt before fading. Long enough to register, short enough not to
 *  obscure the next interaction. */
const INVALID_FLASH_MS = 700;

export const HexAddrInput: Component<HexAddrInputProps> = (props) => {
  const padTo = () => props.padTo ?? 4;
  const maxValue = () => props.maxValue ?? 0xffff;

  const [text, setText] = createSignal("");
  const [focused, setFocused] = createSignal(false);
  const [invalid, setInvalid] = createSignal(false);

  // The displayed value: while focused, whatever the user typed (possibly
  // empty); otherwise the canonical hex of the committed value. The
  // placeholder is the committed value when focused-and-empty.
  const displayValue = (): string =>
    focused() ? text() : formatHex(props.committed(), padTo());
  const placeholderValue = (): string =>
    focused() ? formatHex(props.committed(), padTo()) : "";

  const parseValue = (s: string): number | null => {
    const v = parseHex(s);
    if (v === null) return null;
    if (v < 0 || v > maxValue()) return null;
    return v;
  };

  let invalidTimer: ReturnType<typeof setTimeout> | null = null;
  const flashInvalid = (): void => {
    setInvalid(true);
    if (invalidTimer !== null) clearTimeout(invalidTimer);
    invalidTimer = setTimeout(() => {
      setInvalid(false);
      invalidTimer = null;
    }, INVALID_FLASH_MS);
  };
  onCleanup(() => {
    if (invalidTimer !== null) clearTimeout(invalidTimer);
  });

  // External reset signal — drops local edit state without committing.
  // Used when a parent's form-style submit succeeds (e.g. Program
  // AddStub's Add) and the input should re-show its placeholder /
  // committed value with no in-flight text.
  createEffect((prev: number | undefined): number | undefined => {
    const v = props.resetSignal?.();
    if (v !== undefined && prev !== undefined && v !== prev) {
      setText("");
      setFocused(false);
      setInvalid(false);
    }
    return v;
  }, undefined);

  /** Close the input: clear our focused state (covers test fixtures
   *  that skip the DOM focus event) AND call .blur() so DOM focus also
   *  moves off. handleBlur is idempotent so the path where blur DOES
   *  fire onBlur still works. */
  const closeInput = (el: HTMLInputElement): void => {
    setFocused(false);
    el.blur();
  };

  const handleFocus = (): void => {
    setText("");
    setFocused(true);
    setInvalid(false);
  };

  const handleInput = (
    e: InputEvent & { currentTarget: HTMLInputElement },
  ): void => {
    // CRITICAL: capture the typed value BEFORE any signal write. The
    // reactive `value={displayValue()}` rebinds when `focused` flips
    // true (displayValue switches to reading text() which is still ""),
    // overwriting `e.currentTarget.value` to "" before our setText
    // reads it. Capturing into `v` first sidesteps that race.
    const v = e.currentTarget.value;
    if (!focused()) setFocused(true);
    setText(v);
    setInvalid(false);
  };

  const handleKeyDown = (
    e: KeyboardEvent & { currentTarget: HTMLInputElement },
  ): void => {
    if (e.key === "Enter") {
      const t = text();
      if (t === "") {
        // Empty Enter — leave the field. Blur silently reverts to committed.
        closeInput(e.currentTarget);
        return;
      }
      const parsed = parseValue(t);
      if (parsed === null) {
        // Invalid: flash + revert text; KEEP focus so the user can retype
        // without clicking back in (per the spec).
        flashInvalid();
        setText("");
        return;
      }
      const result = props.commit(parsed);
      if (result === false) {
        // Commit rejected (cross-field, etc.) — same UX as parse-invalid.
        flashInvalid();
        setText("");
        return;
      }
      props.onJumpAfterEnter?.();
      // Clear local edit so the immediately-following blur is a no-op
      // (text is "" → blur returns early) — avoids a double commit().
      setText("");
      closeInput(e.currentTarget);
    } else if (e.key === "Escape") {
      setText("");
      setInvalid(false);
      closeInput(e.currentTarget);
    }
  };

  const handleBlur = (): void => {
    setFocused(false);
    const t = text();
    if (t === "") {
      // Empty — already reverted by the unfocused render. Clear any
      // stale invalid flash so the field doesn't keep the red border
      // after the user moves on.
      setInvalid(false);
      return;
    }
    const parsed = parseValue(t);
    if (parsed === null) {
      // Typed garbage then blurred — flash so the user sees their
      // input was rejected rather than silently disappearing.
      flashInvalid();
      setText("");
      return;
    }
    const result = props.commit(parsed);
    if (result === false) {
      flashInvalid();
      setText("");
      return;
    }
    setText("");
    setInvalid(false);
  };

  return (
    <input
      type="text"
      id={props.id}
      class={props.class}
      classList={{
        ...(props.classList ?? {}),
        // OR semantics with caller-supplied `is-invalid` so a parent
        // that drives its own validity (e.g. AddStub's blocked-picker
        // case) still lights up the field.
        "is-invalid": invalid() || Boolean(props.classList?.["is-invalid"]),
      }}
      value={displayValue()}
      placeholder={placeholderValue()}
      size={props.size}
      maxLength={props.maxLength}
      aria-label={props.ariaLabel}
      title={props.title}
      disabled={props.disabled}
      ref={props.ref}
      onFocus={handleFocus}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    />
  );
};
