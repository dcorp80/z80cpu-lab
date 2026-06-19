// MVP hotkey bindings. New bindings register here; the
// cheat-sheet overlay derives itself from `registry.list()`, so adding
// a row here makes it appear in the overlay automatically.

import type { Store } from "../store/index.ts";
import type { HotkeyRegistry } from "./registry.ts";

export function registerDefaultHotkeys(
  registry: HotkeyRegistry,
  store: Store,
): void {
  // Step / Zero HC / Cold boot are paused-only, matching the equivalent
  // buttons in their sections. The buttons set `disabled` on !paused;
  // the hotkeys silently no-op so a held key during a run doesn't queue
  // up actions that would surprise the user mid-frame.
  const ifPaused = (fn: () => void) => () => {
    if (store.isPaused()) fn();
  };

  registry.register({
    key: " ",
    scope: "global",
    action: () => (store.isPaused() ? store.run() : store.pause()),
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
  // gear). The dispatcher already
  // routes by scope, so this is purely additive.
  registry.register({
    key: "s",
    scope: "global",
    action: ifPaused(() => store.stepInstructions(1)),
    description: "Step one instruction",
    category: "execution",
  });
  registry.register({
    key: "s",
    shift: true,
    scope: "global",
    action: ifPaused(() => store.stepHC(1)),
    description: "Step one half-cycle",
    category: "execution",
  });
  registry.register({
    key: "z",
    shift: true,
    scope: "global",
    // TODO: gate behind save-or-skip modal once snapshot /
    // HW-trace buffers exist (M8c / M9). Direct call for now matches
    // the Zero HC button.
    action: ifPaused(() => store.zeroHC()),
    description: "Zero the HC counter",
    category: "destructive",
  });
  registry.register({
    key: "r",
    shift: true,
    scope: "global",
    // `store.coldBoot()` is the single owner of the paused-gate and the
    // (future) save-or-skip modal — see store/index.ts. The App-shell
    // section's Cold boot button calls the same action.
    action: () => store.coldBoot(),
    description:
      "Cold boot (page reload — files / breakpoints / layout survive; autoload re-fires)",
    category: "destructive",
  });
  registry.register({
    key: "g",
    scope: "global",
    // Snaps BOTH cursors in one call. Runnable regardless of pause state — a
    // detached cursor can pile up history during a long run; snap-to-
    // live must work without requiring the user to pause first.
    action: () => {
      store.snapInstructionTraceCursorToLive();
      store.snapHwTraceCursorToLive();
    },
    description: "Snap detached trace cursor(s) to live",
    category: "navigation",
  });
}
