// MVP hotkey bindings (REQ §7.8). New bindings register here; the
// cheat-sheet overlay derives itself from `registry.list()`, so adding
// a row here makes it appear in the overlay automatically.

import type { Store } from "../store/index.ts";
import type { HotkeyRegistry } from "./registry.ts";

export function registerDefaultHotkeys(
  registry: HotkeyRegistry,
  store: Store,
): void {
  // Step / Zero HC / Reinit are paused-only, matching the equivalent
  // buttons in the Breakpoints header. The buttons set `disabled` on
  // !paused; the hotkeys silently no-op so a held key during a run
  // doesn't queue up actions that would surprise the user mid-frame.
  const ifPaused = (fn: () => void) => () => {
    if (store.status() === "paused") fn();
  };

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
    // TODO(REQ §7.4): gate behind save-or-skip modal once snapshot /
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
    // TODO(REQ §7.4): gate behind save-or-skip modal once buffers exist
    // (M8c / M9). For now Reinit goes straight through.
    action: ifPaused(() => {
      window.location.reload();
    }),
    description:
      "Reinit (page reload — files / breakpoints / layout survive; autoload re-fires)",
    category: "destructive",
  });
  registry.register({
    key: "g",
    scope: "global",
    // Snaps BOTH cursors in one call (DESIGN §3.6: "M8 extends the same
    // handler to snap both"). Runnable regardless of pause state — a
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
