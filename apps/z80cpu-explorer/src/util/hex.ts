export function formatHex(value: number, padTo = 0): string {
  return value.toString(16).toUpperCase().padStart(padTo, "0");
}

const HEX_RE = /^(?:\$|0x)?([0-9a-f]+)h?$/i;

export function parseHex(s: string): number | null {
  const m = HEX_RE.exec(s.trim());
  if (!m) return null;
  return Number.parseInt(m[1], 16);
}
