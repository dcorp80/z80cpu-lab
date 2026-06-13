export function formatHex(value: number, padTo = 0): string {
  return value.toString(16).toUpperCase().padStart(padTo, "0");
}

// Prefix-form (`$` or `0x`) and suffix-form (`h`) are mutually exclusive;
// `$FFh` and `0xFFh` are rejected as malformed.
const HEX_RE = /^(?:(?:\$|0x)([0-9a-f]+)|([0-9a-f]+)h?)$/i;

export function parseHex(s: string): number | null {
  const m = HEX_RE.exec(s.trim());
  if (!m) return null;
  return Number.parseInt(m[1] ?? m[2], 16);
}

/**
 * Strip characters that could never be part of a valid hex literal in
 * any of our accepted notations (`FF`, `$FF`, `0xFF`, `FFh`). Applied
 * on input so typos disappear visually before the user blurs/enters.
 * Semantic validation still happens via `parseHex` / `parseAddr16` on
 * commit — this filter is purely a UX guard.
 */
export function filterHexInput(s: string): string {
  return s.replace(/[^0-9a-fA-F$xXhH]/g, "");
}

/** Parses a 16-bit address. Returns null for invalid hex OR values > 0xFFFF. */
export function parseAddr16(s: string): number | null {
  const v = parseHex(s);
  if (v === null) return null;
  if (v < 0 || v > 0xffff) return null;
  return v;
}
