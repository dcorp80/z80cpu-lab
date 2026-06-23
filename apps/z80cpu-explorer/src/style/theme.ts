// Theme controller. Three modes per REQ §7.6:
//   - "light"  / "dark" — explicit override of the OS preference
//   - "system" (default) — follows `prefers-color-scheme`, reacts live
//     to OS-level changes
//
// The mechanism is CSS-only: `styles.css` declares light tokens on `:root`
// and dark overrides under `:root[data-theme="dark"]` plus a media query
// scoped to "neither light nor dark" (i.e. system / unset). All this
// module does is write `data-theme` on `<html>` so the right selector
// branch fires. System mode therefore needs no JS listener — the browser
// re-evaluates the media query when the OS preference flips, and the
// token swap propagates through `var(--*)` automatically.
//
// `applyThemeAttribute` also mirrors the choice into localStorage; the
// inline boot script in `index.html` reads that cache synchronously
// before first paint so a persisted choice doesn't FOUC while the async
// storage backend is still opening.

export type Theme = "light" | "dark" | "system";

export const DEFAULT_THEME: Theme = "system";
const DATA_THEME_ATTR = "data-theme";
/** localStorage key for the pre-paint theme cache, read by the inline
 *  boot script in `index.html`. Keep this key in sync with that script —
 *  the script can't import from the bundle since it runs before module
 *  scripts execute. */
export const THEME_STORAGE_KEY = "z80cpu-explorer:theme";

export function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

/** Coerce a persisted/external value to a valid Theme. Anything not in
 *  the closed set (incl. null/undefined from a fresh boot or a corrupt
 *  backend) collapses to the default — same boundary-validation pattern
 *  the rest of the store uses for persisted scalars. */
export function sanitizeTheme(v: unknown): Theme {
  return isTheme(v) ? v : DEFAULT_THEME;
}

/** Write the active theme onto `<html>` so the CSS selectors match,
 *  and mirror it into localStorage so the inline boot script can apply
 *  it pre-paint on subsequent visits. No-op outside a browser (test
 *  runners without a DOM). localStorage writes are best-effort —
 *  private-mode browsers throw, and the async store remains authoritative. */
export function applyThemeAttribute(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(DATA_THEME_ATTR, theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode, disabled, quota). Pre-paint
    // optimization is lost for next boot but theming still works.
  }
}
