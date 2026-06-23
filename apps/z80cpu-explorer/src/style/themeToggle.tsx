import { type Component, For } from "solid-js";
import { useStore } from "../store/index.ts";
import { STR } from "./strings.ts";
import type { Theme } from "./theme.ts";

const OPTIONS: ReadonlyArray<{ value: Theme; label: string; tooltip: string }> =
  [
    {
      value: "light",
      label: STR.theme.optionLight,
      tooltip: STR.theme.tooltipLight,
    },
    {
      value: "dark",
      label: STR.theme.optionDark,
      tooltip: STR.theme.tooltipDark,
    },
    {
      value: "system",
      label: STR.theme.optionSystem,
      tooltip: STR.theme.tooltipSystem,
    },
  ];

/** Three-way segmented control for the app header strip. Reads the
 *  current theme off the store and writes back through `setTheme` —
 *  persistence + DOM attribute update are owned by the store. */
export const ThemeToggle: Component = () => {
  const store = useStore();
  return (
    // Each toggle button carries its own text + tooltip, so the
    // accessible name reads cleanly without a wrapping `role="group"`
    // (Biome would otherwise rewrite that to <fieldset>, which brings
    // visual defaults that don't belong in a header strip).
    <div class="theme-toggle">
      <span class="theme-toggle-label">{STR.theme.label}</span>
      <For each={OPTIONS}>
        {(opt) => (
          <button
            type="button"
            class="theme-toggle-btn"
            classList={{ "is-selected": store.theme() === opt.value }}
            aria-pressed={store.theme() === opt.value}
            title={opt.tooltip}
            onClick={() => store.setTheme(opt.value)}
          >
            {opt.label}
          </button>
        )}
      </For>
    </div>
  );
};
