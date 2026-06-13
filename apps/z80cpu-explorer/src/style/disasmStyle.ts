// Disasm output post-processor — strips the `h` suffix the upstream
// `@dcorp80/z80cpu-disasm` STYLE object appends (e.g. `FFh`, `1234h`) so
// the explorer renders bare hex per REQ §7.1 and [[feedback_hex_display]].
//
// This is a temporary boundary — DESIGN §7 / milestone 11 swap to a
// proper STYLE override in the disasm package itself, at which point
// this helper goes away and consumers call `disasm()` directly.

import { type Disasm, disasm as upstreamDisasm } from "@dcorp80/z80cpu-disasm";

// `XXh` and `XXXXh` follow `[0-9A-F]` strictly because the disasm
// formatter always uppercases. Matching only the trailing `h` after a
// run of uppercase hex digits avoids stripping the `h` from real
// mnemonics like `HALT`, `LDH` (not Z80, but defensive).
const HEX_SUFFIX_RE = /\b([0-9A-F]+)h\b/g;

export function bareHex(text: string): string {
  return text.replace(HEX_SUFFIX_RE, "$1");
}

/** Same return shape as the upstream `disasm()`, with bare-hex text. */
export function disasm(bytes: ArrayLike<number>): Disasm {
  const out = upstreamDisasm(bytes);
  out.text = bareHex(out.text);
  return out;
}
