// Document-level keydown dispatcher. Input suppression: any binding with
// `scope: 'global'` is skipped while the active element accepts text
// (input/textarea/[contenteditable]). Modal scope is reserved for the
// save-or-skip modal and friends; milestone 2 has no modals yet, so the
// `isModalOpen` reader is wired but always returns false.

import {
  type HotkeyBinding,
  type HotkeyRegistry,
  normalizeKey,
} from "./registry.ts";

export interface DispatchDeps {
  /** Returns true when a modal owns key input. Milestone 2: always false. */
  isModalOpen?: () => boolean;
  /** Document-like target for the keydown listener — defaults to document. */
  target?: EventTarget;
}

export type Detach = () => void;

export function installHotkeyDispatcher(
  registry: HotkeyRegistry,
  deps: DispatchDeps = {},
): Detach {
  const isModalOpen = deps.isModalOpen ?? (() => false);
  const target: EventTarget =
    deps.target ??
    (typeof document !== "undefined" ? document : new EventTarget());

  const handler = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (event.defaultPrevented) return;
    const match = findMatch(registry.list(), event, isModalOpen());
    if (!match) return;
    // Global bindings are suppressed when text input is focused.
    if (match.scope === "global" && isTextInputFocused()) return;
    event.preventDefault();
    match.action();
  };

  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}

export function findMatch(
  bindings: ReadonlyArray<HotkeyBinding>,
  event: KeyboardEvent,
  modalOpen: boolean,
): HotkeyBinding | undefined {
  const key = normalizeKey(event.key);
  // Iterate from newest to oldest so the override rule (last-registered
  // wins) holds at dispatch time too.
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (modalOpen && b.scope !== "modal") continue;
    if (!modalOpen && b.scope !== "global") continue;
    if (normalizeKey(b.key) !== key) continue;
    if (!!b.shift !== event.shiftKey) continue;
    if (!!b.ctrl !== event.ctrlKey) continue;
    if (!!b.alt !== event.altKey) continue;
    if (!!b.meta !== event.metaKey) continue;
    return b;
  }
  return undefined;
}

export function isTextInputFocused(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}
