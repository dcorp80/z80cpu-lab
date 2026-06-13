// Collision-resistant ids for store-local objects (files, breakpoints,
// snapshots). Used as React-style stable keys; we want enough entropy
// that accidental collisions across a session are effectively impossible.
// `crypto.randomUUID()` gives 122 bits of randomness from a CSPRNG —
// available in all browsers we target (Chrome 92+, Firefox 95+, Safari
// 15.4+) and in Node 19+ (we require 24+).

export function shortId(): string {
  return crypto.randomUUID();
}
