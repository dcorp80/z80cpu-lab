# @dcorp80/z80cpu-disasm

Standalone Z80 disassembler. Stateless, dependency-free, byte-window-oriented.
Designed for use against trace byte arrays from [`@dcorp80/z80cpu-debug`](../z80cpu-debug)
or any other source — but has no runtime dependency on the emulator.

> Currently private to this workspace. Not published.

## Usage

```ts
import { disasm } from "@dcorp80/z80cpu-disasm";

disasm([0x3E, 0x42]);
// → { text: "LD A,42h", length: 2 }

disasm([0xDD, 0x21, 0x34, 0x12]);
// → { text: "LD IX,1234h", length: 4, abs: 0x1234 }

disasm([0xCB, 0x47]);
// → { text: "BIT 0,A", length: 2 }

disasm([0xDD]);
// → { text: "DDh", length: 1 }   // lone prefix surfaces per STYLE.orphanPrefix
```

`disasm` consumes as many bytes as the instruction requires and returns:

| Field | Meaning |
|---|---|
| `text` | mnemonic + operand string |
| `length` | bytes consumed (1..4) |
| `undocumented?` | `true` if the encoding is documented as illegal/undocumented |
| `rel?` | signed JR/DJNZ displacement (added to PC after the instruction) |
| `abs?` | absolute 16-bit address for CALL nn / JP nn / LD (nn),... |
| `indexD?` | signed (IX+d)/(IY+d) byte for indexed addressing |

Empty input returns `{ text: "", length: 0 }`.

## Styling

All user-visible text and number formatting lives in `STYLE` at the top of
`z80disasm.ts`. Restyle the entire output (case, hex prefix/suffix, separators,
register names) by editing that single object.
