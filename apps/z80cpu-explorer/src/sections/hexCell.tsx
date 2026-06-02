// Shared hex cell editor used by HexGrid (Memory + IO 16-bit) and the
// IO 8-bit port grid. Pulled out so the rapid-entry editor lives in one
// place; the only knob is `addrPadTo` (4 for 16-bit address space, 2
// for IO 8-bit). Address text shows up in `data-addr` (the grid's
// advance lookup) and the aria-label, so the padding has to match what
// the parent grid's advance queries for.

import { type Accessor, type Component, createSignal, Show } from "solid-js";
import { STR } from "../style/strings.ts";
import { filterHexInput, formatHex, parseHex } from "../util/hex.ts";

export interface HexCellProps {
  addr: number;
  byte: number;
  isWatch: boolean;
  paused: Accessor<boolean>;
  setByte: (addr: number, value: number) => void;
  /** Called after a successful Enter commit so the grid can open the
   *  next cell. Invalid / empty Enters do NOT call this. */
  advance: (addr: number) => void;
  /** Hex-digit width for `data-addr` + aria-label. Default 4 (16-bit
   *  address space). Pass 2 for the IO 8-bit port grid. */
  addrPadTo?: number;
  /** Extra classList entries merged onto the cell button (caller-driven
   *  cues like `.is-alias-mismatch` for the IO 8-bit grid). The cell
   *  also adds its own `.is-watch-cell` / `.is-editable`. */
  extraClassList?: Record<string, boolean | undefined>;
  /** Hover tooltip on the cell button. The grid uses this for cues
   *  that need explanation (alias mismatch etc.). */
  title?: string;
}

export const HexCell: Component<HexCellProps> = (props) => {
  const padTo = () => props.addrPadTo ?? 4;
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");
  const [invalid, setInvalid] = createSignal(false);

  /** Parse + write. Returns "ok" / "invalid" / "empty" so callers can
   *  drive different post-commit behavior (advance, revert + stay, close). */
  const tryCommit = (): "ok" | "invalid" | "empty" => {
    const t = text();
    if (t === "") return "empty";
    const v = parseHex(t);
    if (v === null || v < 0 || v > 0xff) return "invalid";
    props.setByte(props.addr, v);
    return "ok";
  };

  const beginEdit = () => {
    if (!props.paused()) return;
    setText(formatHex(props.byte, 2));
    setInvalid(false);
    setEditing(true);
  };

  return (
    <button
      type="button"
      class="hex-cell"
      classList={{
        ...(props.extraClassList ?? {}),
        "is-watch-cell": props.isWatch,
        "is-editable": props.paused(),
      }}
      // tabIndex={-1} keeps cells out of the natural tab order; full
      // grid keyboard nav (arrow keys, etc.) is post-MVP and the
      // section header's watch input is the keyboard entry point.
      tabIndex={-1}
      data-addr={formatHex(props.addr, padTo())}
      title={props.title}
      onClick={beginEdit}
    >
      <Show when={editing()} fallback={<span>{formatHex(props.byte, 2)}</span>}>
        <input
          type="text"
          class="hex-cell-input"
          classList={{ "is-invalid": invalid() }}
          aria-label={STR.hexGrid.cellEditAriaLabel(
            formatHex(props.addr, padTo()),
          )}
          maxLength={2}
          value={text()}
          // Imperative focus on mount — the HTML `autofocus` attribute
          // only fires at document load, not when an element is
          // inserted dynamically. The button we just clicked still owns
          // focus when this input mounts; without this call the input
          // renders un-focused and the browser logs
          // "Autofocus processing was blocked because a document already
          //  has a focused element". `.select()` highlights the seeded
          // hex so the user can type-replace immediately — and so the
          // rapid-entry advance lands the user on a pre-selected next
          // cell ready to overwrite.
          ref={(el) => {
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          onInput={(e) => {
            setText(filterHexInput(e.currentTarget.value));
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const result = tryCommit();
              if (result === "ok") {
                // Clear so the subsequent blur doesn't re-commit.
                setText("");
                setInvalid(false);
                // Schedule the advance BEFORE blur — the blur closes
                // this cell, freeing the focus the next cell will take.
                props.advance(props.addr);
                (e.currentTarget as HTMLInputElement).blur();
              } else if (result === "invalid") {
                // Revert text, KEEP editing so user can retype without
                // re-clicking. The flash gives a moment of feedback.
                setInvalid(true);
                setText("");
              } else {
                // Empty Enter — close.
                (e.currentTarget as HTMLInputElement).blur();
              }
            } else if (e.key === "Escape") {
              setText("");
              setInvalid(false);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          onBlur={() => {
            // Implicit commit on blur (user clicked elsewhere). text===""
            // means we already committed via Enter, or the user never
            // typed — either way, leave the cell value untouched.
            const t = text();
            if (t !== "") {
              const v = parseHex(t);
              if (v !== null && v >= 0 && v <= 0xff) {
                props.setByte(props.addr, v);
              }
            }
            setEditing(false);
            setInvalid(false);
          }}
        />
      </Show>
    </button>
  );
};
