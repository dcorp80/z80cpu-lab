export function formatHex(value: number, padTo = 0): string {
  return value.toString(16).toUpperCase().padStart(padTo, "0");
}

const HEX_RE = /^(?:\$|0x)?([0-9a-f]+)h?$/i;

export function parseHex(s: string): number | null {
  const m = HEX_RE.exec(s.trim());
  if (!m) return null;
  return Number.parseInt(m[1], 16);
}

/** Parses a 16-bit address. Returns null for invalid hex OR values > 0xFFFF. */
export function parseAddr16(s: string): number | null {
  const v = parseHex(s);
  if (v === null) return null;
  if (v < 0 || v > 0xffff) return null;
  return v;
}
