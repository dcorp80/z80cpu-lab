// Hotkey registry. The registry IS the catalog — there is no second
// source of truth for the cheat-sheet overlay (DESIGN §6.1).

export interface HotkeyBinding {
  /**
   * Match against `event.key.toLowerCase()`. For letters/digits this is
   * just the character ('s', '?'). For special keys use the canonical
   * lowercase name: 'escape', ' ' for space, 'enter', etc.
   * We accept 'space' as an alias for ' '.
   */
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  scope: "global" | "modal";
  action: () => void;
  description: string;
  category?: string;
}

export type Unsubscribe = () => void;

export interface HotkeyRegistry {
  register(b: HotkeyBinding): Unsubscribe;
  list(): ReadonlyArray<HotkeyBinding>;
}

export function createHotkeyRegistry(): HotkeyRegistry {
  const bindings: HotkeyBinding[] = [];
  return {
    register(b) {
      // Last-registered wins on conflict (DESIGN §6.1). Detect & warn in
      // dev so the post-MVP customization path stays obvious.
      const existing = bindings.findIndex((x) => sameTrigger(x, b));
      if (existing >= 0) {
        console.warn(
          `[hotkeys] overriding binding for ${describeTrigger(b)} ` +
            `(was: "${bindings[existing].description}", ` +
            `now: "${b.description}")`,
        );
        bindings.splice(existing, 1);
      }
      bindings.push(b);
      return () => {
        const i = bindings.indexOf(b);
        if (i >= 0) bindings.splice(i, 1);
      };
    },
    list() {
      return bindings;
    },
  };
}

function sameTrigger(a: HotkeyBinding, b: HotkeyBinding): boolean {
  return (
    a.scope === b.scope &&
    normalizeKey(a.key) === normalizeKey(b.key) &&
    !!a.shift === !!b.shift &&
    !!a.ctrl === !!b.ctrl &&
    !!a.alt === !!b.alt &&
    !!a.meta === !!b.meta
  );
}

export function normalizeKey(k: string): string {
  const lower = k.toLowerCase();
  if (lower === "space") return " ";
  return lower;
}

function describeTrigger(b: HotkeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.meta) parts.push("Meta");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(b.key === " " ? "Space" : b.key);
  return `${b.scope}:${parts.join("+")}`;
}
