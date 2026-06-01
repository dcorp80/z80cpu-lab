// Width selector shared by Memory and IO. Native `<select>` keeps the
// keyboard/screen-reader story trivial; the value set is fixed at
// build time so no dropdown UI heroics required.

import type { Accessor, Component } from "solid-js";
import { For } from "solid-js";
import { BYTES_PER_ROW_OPTIONS } from "../config/defaults.ts";
import { STR } from "../style/strings.ts";

export interface BytesPerRowSelectProps {
  value: Accessor<number>;
  setValue: (n: number) => void;
}

export const BytesPerRowSelect: Component<BytesPerRowSelectProps> = (props) => {
  return (
    <label class="bpr-select">
      <span class="bpr-select-label">{STR.hexGrid.bytesPerRowLabel}</span>
      <select
        class="bpr-select-field"
        aria-label={STR.hexGrid.bytesPerRowAriaLabel}
        value={String(props.value())}
        onChange={(e) => props.setValue(Number(e.currentTarget.value))}
      >
        <For each={BYTES_PER_ROW_OPTIONS}>
          {(n) => <option value={String(n)}>{n}</option>}
        </For>
      </select>
    </label>
  );
};
