// MVP hotkey bindings (REQ §7.8). New bindings register here; the
// cheat-sheet overlay derives itself from `registry.list()`, so adding
// a row here makes it appear in the overlay automatically.

import type { Store } from "../store/index.ts";
import type { HotkeyRegistry } from "./registry.ts";

export function registerDefaultHotkeys(
  registry: HotkeyRegistry,
  store: Store,
): void {
  registry.register({
    key: " ",
    scope: "global",
    action: () => (store.status() === "paused" ? store.run() : store.pause()),
    description: "Run / pause",
    category: "execution",
  });
  registry.register({
    key: "escape",
    scope: "global",
    action: () => store.pause(),
    description: "Pause running CPU",
    category: "execution",
  });
  // TODO(milestone 9): register a second `escape` binding with
  // `scope: 'modal'` that dismisses the active modal (save-or-skip,
  // gear). REQ §7.8: "Esc always dismisses". The dispatcher already
  // routes by scope, so this is purely additive.
  registry.register({
    key: "s",
    scope: "global",
    action: () => store.stepInstructions(1),
    description: "Step one instruction",
    category: "execution",
  });
}
