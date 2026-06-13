/** Parse a decimal string to a positive integer (> 0), or `null` if
 *  the input is empty, non-numeric, NaN, zero, or negative. Used by
 *  Step-N controls that share a "blank/invalid → no-op" policy. */
export function parsePositiveInt(s: string): number | null {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
