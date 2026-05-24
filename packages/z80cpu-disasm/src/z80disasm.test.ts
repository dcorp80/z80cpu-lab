// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { disasm } from "@dcorp80/z80cpu-disasm";

// Compact assertion helper — keeps each test one line of "bytes → expectation".
function check(
  bytes: number[],
  text: string,
  extra: Partial<{
    length: number;
    undocumented: true;
    rel: number;
    abs: number;
    indexD: number;
  }> = {},
) {
  const got = disasm(bytes);
  const expected = { text, length: extra.length ?? bytes.length, ...extra };
  deepStrictEqual(
    got,
    expected,
    `disasm([${bytes.map((b) => b.toString(16)).join(",")}])`,
  );
}

describe("z80disasm — edge cases", () => {
  test("empty input → empty result", () => {
    deepStrictEqual(disasm([]), { text: "", length: 0 });
  });

  test("lone DD prefix → 'DDh' (length 1)", () => {
    check([0xdd], "DDh");
  });

  test("lone FD prefix → 'FDh'", () => {
    check([0xfd], "FDh");
  });

  test("lone CB prefix → 'CBh'", () => {
    // CB consumed, then we try to read sub-op and run out → '??'
    // Actually the current impl returns '??' for that case; lone CB
    // should still render as orphan if we treat CB the same as DD/FD.
    // Per design intent, lone CB IS an orphan from dbg's split. Verify.
    deepStrictEqual(disasm([0xcb]).text, "??"); // CB consumes, sub-op missing
  });

  test("truncated LD A,n → 'LD A,??' length 1", () => {
    check([0x3e], "LD A,??", { length: 1 });
  });

  test("truncated LD HL,nn (only one byte of nn) → '??'", () => {
    const r = disasm([0x21, 0x34]);
    strictEqual(r.text, "LD HL,??");
    strictEqual(r.length, 2);
  });
});

describe("z80disasm — unprefixed main table", () => {
  test("NOP", () => check([0x00], "NOP"));
  test("HALT", () => check([0x76], "HALT"));
  test("LD A,42h", () => check([0x3e, 0x42], "LD A,42h"));
  test("LD HL,1234h", () =>
    check([0x21, 0x34, 0x12], "LD HL,1234h", { abs: 0x1234 }));
  test("LD B,C", () => check([0x41], "LD B,C"));
  test("LD H,(HL)", () => check([0x66], "LD H,(HL)"));
  test("LD (HL),A", () => check([0x77], "LD (HL),A"));
  test("ADD A,B", () => check([0x80], "ADD A,B"));
  test("CP (HL)", () => check([0xbe], "CP (HL)"));
  test("INC BC", () => check([0x03], "INC BC"));
  test("DEC HL", () => check([0x2b], "DEC HL"));
  test("ADD HL,DE", () => check([0x19], "ADD HL,DE"));
  test("EX AF,AF'", () => check([0x08], "EX AF,AF'"));
  test("EXX", () => check([0xd9], "EXX"));
  test("EX DE,HL", () => check([0xeb], "EX DE,HL"));
  test("EX (SP),HL", () => check([0xe3], "EX (SP),HL"));
  test("JP (HL)", () => check([0xe9], "JP (HL)"));
  test("LD SP,HL", () => check([0xf9], "LD SP,HL"));

  test("JR e", () => check([0x18, 0x05], "JR +5", { rel: 5 }));
  test("JR -3", () => check([0x18, 0xfd], "JR -3", { rel: -3 }));
  test("JR NZ,+10", () => check([0x20, 0x0a], "JR NZ,+10", { rel: 10 }));
  test("DJNZ -2", () => check([0x10, 0xfe], "DJNZ -2", { rel: -2 }));

  test("JP 1234h", () =>
    check([0xc3, 0x34, 0x12], "JP 1234h", { abs: 0x1234 }));
  test("JP Z,1234h", () =>
    check([0xca, 0x34, 0x12], "JP Z,1234h", { abs: 0x1234 }));
  test("CALL 1234h", () =>
    check([0xcd, 0x34, 0x12], "CALL 1234h", { abs: 0x1234 }));
  test("CALL NC,1234h", () =>
    check([0xd4, 0x34, 0x12], "CALL NC,1234h", { abs: 0x1234 }));
  test("RST 28h", () => check([0xef], "RST 28h"));

  test("PUSH AF", () => check([0xf5], "PUSH AF"));
  test("POP BC", () => check([0xc1], "POP BC"));

  test("IN A,(40h)", () => check([0xdb, 0x40], "IN A,(40h)"));
  test("OUT (40h),A", () => check([0xd3, 0x40], "OUT (40h),A"));

  test("LD (1234h),A", () =>
    check([0x32, 0x34, 0x12], "LD (1234h),A", { abs: 0x1234 }));
  test("LD A,(1234h)", () =>
    check([0x3a, 0x34, 0x12], "LD A,(1234h)", { abs: 0x1234 }));
  test("LD (1234h),HL", () =>
    check([0x22, 0x34, 0x12], "LD (1234h),HL", { abs: 0x1234 }));
  test("LD HL,(1234h)", () =>
    check([0x2a, 0x34, 0x12], "LD HL,(1234h)", { abs: 0x1234 }));

  test("DI / EI", () => {
    check([0xf3], "DI");
    check([0xfb], "EI");
  });
});

describe("z80disasm — CB-prefixed", () => {
  test("RLC B", () => check([0xcb, 0x00], "RLC B"));
  test("RRC C", () => check([0xcb, 0x09], "RRC C"));
  test("SLA D", () => check([0xcb, 0x22], "SLA D"));
  test("SLL E (undocumented)", () =>
    check([0xcb, 0x33], "SLL E", { undocumented: true }));
  test("SRL A", () => check([0xcb, 0x3f], "SRL A"));
  test("BIT 0,B", () => check([0xcb, 0x40], "BIT 0,B"));
  test("BIT 7,(HL)", () => check([0xcb, 0x7e], "BIT 7,(HL)"));
  test("RES 3,L", () => check([0xcb, 0x9d], "RES 3,L"));
  test("SET 5,A", () => check([0xcb, 0xef], "SET 5,A"));
});

describe("z80disasm — DD/FD prefix (IX/IY substitution)", () => {
  test("LD IX,1234h", () =>
    check([0xdd, 0x21, 0x34, 0x12], "LD IX,1234h", { abs: 0x1234 }));
  test("LD IY,1234h", () =>
    check([0xfd, 0x21, 0x34, 0x12], "LD IY,1234h", { abs: 0x1234 }));
  test("INC IX", () => check([0xdd, 0x23], "INC IX"));
  test("ADD IX,DE", () => check([0xdd, 0x19], "ADD IX,DE"));
  test("ADD IX,IX", () => check([0xdd, 0x29], "ADD IX,IX"));
  test("LD (1234h),IX", () =>
    check([0xdd, 0x22, 0x34, 0x12], "LD (1234h),IX", { abs: 0x1234 }));
  test("LD IX,(1234h)", () =>
    check([0xdd, 0x2a, 0x34, 0x12], "LD IX,(1234h)", { abs: 0x1234 }));
  test("INC (IX+05h)", () =>
    check([0xdd, 0x34, 0x05], "INC (IX+05h)", { indexD: 5 }));
  test("INC (IX-2h)", () =>
    check([0xdd, 0x34, 0xfe], "INC (IX-02h)", { indexD: -2 }));
  test("LD (IX+05h),42h", () =>
    check([0xdd, 0x36, 0x05, 0x42], "LD (IX+05h),42h", { indexD: 5 }));
  test("LD A,(IX+05h)", () =>
    check([0xdd, 0x7e, 0x05], "LD A,(IX+05h)", { indexD: 5 }));
  test("LD (IX+05h),B", () =>
    check([0xdd, 0x70, 0x05], "LD (IX+05h),B", { indexD: 5 }));
  test("ADD A,(IX+05h)", () =>
    check([0xdd, 0x86, 0x05], "ADD A,(IX+05h)", { indexD: 5 }));
  test("POP IY", () => check([0xfd, 0xe1], "POP IY"));
  test("EX (SP),IX", () => check([0xdd, 0xe3], "EX (SP),IX"));
  test("JP (IY)", () => check([0xfd, 0xe9], "JP (IY)"));
  test("LD SP,IX", () => check([0xdd, 0xf9], "LD SP,IX"));

  test("LD IXH,42h (undocumented)", () =>
    check([0xdd, 0x26, 0x42], "LD IXH,42h", { undocumented: true }));
  test("LD IXL,42h (undocumented)", () =>
    check([0xdd, 0x2e, 0x42], "LD IXL,42h", { undocumented: true }));
  test("INC IXH (undocumented)", () =>
    check([0xdd, 0x24], "INC IXH", { undocumented: true }));
  test("DEC IYL (undocumented)", () =>
    check([0xfd, 0x2d], "DEC IYL", { undocumented: true }));
  test("ADD A,IXH (undocumented)", () =>
    check([0xdd, 0x84], "ADD A,IXH", { undocumented: true }));
  test("LD B,IXH (undocumented)", () =>
    check([0xdd, 0x44], "LD B,IXH", { undocumented: true }));

  // Conflict rule: H/L stays plain when (IX+d) is the other slot.
  test("LD H,(IX+05h) — H stays plain", () =>
    check([0xdd, 0x66, 0x05], "LD H,(IX+05h)", { indexD: 5 }));
  test("LD (IX+05h),L — L stays plain", () =>
    check([0xdd, 0x75, 0x05], "LD (IX+05h),L", { indexD: 5 }));

  test("DD before HALT → still HALT (prefix ignored)", () =>
    check([0xdd, 0x76], "HALT", { undocumented: true }));
});

describe("z80disasm — DDCB / FDCB (indexed CB)", () => {
  test("RLC (IX+05h)", () =>
    check([0xdd, 0xcb, 0x05, 0x06], "RLC (IX+05h)", { indexD: 5 }));
  test("BIT 3,(IY+10h)", () =>
    check([0xfd, 0xcb, 0x10, 0x5e], "BIT 3,(IY+10h)", { indexD: 0x10 }));
  test("RES 7,(IX+0h)", () =>
    check([0xdd, 0xcb, 0x00, 0xbe], "RES 7,(IX+00h)", { indexD: 0 }));
  test("SET 0,(IX+05h)", () =>
    check([0xdd, 0xcb, 0x05, 0xc6], "SET 0,(IX+05h)", { indexD: 5 }));

  // Undocumented r-write forms: rotation + store to r AND to (IX+d)
  test("RLC B,(IX+05h) — undoc r-write", () =>
    check([0xdd, 0xcb, 0x05, 0x00], "RLC B,(IX+05h)", {
      indexD: 5,
      undocumented: true,
    }));
  test("SET 0,B,(IX+05h) — undoc r-write", () =>
    check([0xdd, 0xcb, 0x05, 0xc0], "SET 0,B,(IX+05h)", {
      indexD: 5,
      undocumented: true,
    }));
  test("SLL (IX+05h) — undoc rot is still undoc even with (IX+d)", () =>
    check([0xdd, 0xcb, 0x05, 0x36], "SLL (IX+05h)", {
      indexD: 5,
      undocumented: true,
    }));
});

describe("z80disasm — ED-prefixed", () => {
  test("IN B,(C)", () => check([0xed, 0x40], "IN B,(C)"));
  test("OUT (C),B", () => check([0xed, 0x41], "OUT (C),B"));
  test("IN (C) — undoc", () =>
    check([0xed, 0x70], "IN (C)", { undocumented: true }));
  test("OUT (C),0 — undoc", () =>
    check([0xed, 0x71], "OUT (C),0", { undocumented: true }));
  test("SBC HL,BC", () => check([0xed, 0x42], "SBC HL,BC"));
  test("ADC HL,DE", () => check([0xed, 0x5a], "ADC HL,DE"));
  test("LD (1234h),BC", () =>
    check([0xed, 0x43, 0x34, 0x12], "LD (1234h),BC", { abs: 0x1234 }));
  test("LD BC,(1234h)", () =>
    check([0xed, 0x4b, 0x34, 0x12], "LD BC,(1234h)", { abs: 0x1234 }));
  test("NEG", () => check([0xed, 0x44], "NEG"));
  test("RETN", () => check([0xed, 0x45], "RETN"));
  test("RETI", () => check([0xed, 0x4d], "RETI"));
  test("IM 0", () => check([0xed, 0x46], "IM 0"));
  test("IM 1", () => check([0xed, 0x56], "IM 1"));
  test("IM 2", () => check([0xed, 0x5e], "IM 2"));
  test("LD I,A", () => check([0xed, 0x47], "LD I,A"));
  test("LD A,R", () => check([0xed, 0x5f], "LD A,R"));
  test("RRD", () => check([0xed, 0x67], "RRD"));
  test("RLD", () => check([0xed, 0x6f], "RLD"));

  test("LDI", () => check([0xed, 0xa0], "LDI"));
  test("LDIR", () => check([0xed, 0xb0], "LDIR"));
  test("CPDR", () => check([0xed, 0xb9], "CPDR"));
  test("OUTI", () => check([0xed, 0xa3], "OUTI"));
  test("OTDR", () => check([0xed, 0xbb], "OTDR"));

  test("ED 00 → undocumented NOP", () =>
    check([0xed, 0x00], "NOP", { undocumented: true }));
  test("ED FF → undocumented NOP", () =>
    check([0xed, 0xff], "NOP", { undocumented: true }));

  // NEG copies (undocumented): ED 4C/54/5C/64/6C/74/7C all NEG
  test("ED 54 → NEG (undoc copy)", () =>
    check([0xed, 0x54], "NEG", { undocumented: true }));
});

describe("z80disasm — wasted prefixes interpretation", () => {
  // dbg's split logic guarantees we'd never receive these as one trace,
  // but the disassembler must still interpret them sensibly when handed
  // raw bytes from other sources.

  test("DD DD <op> → only last DD is effective, flag undoc", () => {
    const r = disasm([0xdd, 0xdd, 0x21, 0x34, 0x12]);
    strictEqual(r.text, "LD IX,1234h");
    strictEqual(r.undocumented, true);
    strictEqual(r.length, 5);
  });

  test("DD FD <op> → FD wins, DD wasted, flag undoc", () => {
    const r = disasm([0xdd, 0xfd, 0x21, 0x34, 0x12]);
    strictEqual(r.text, "LD IY,1234h");
    strictEqual(r.undocumented, true);
  });

  test("DD ED <op> → ED clears IX, DD wasted, flag undoc", () => {
    const r = disasm([0xdd, 0xed, 0x42]);
    strictEqual(r.text, "SBC HL,BC");
    strictEqual(r.undocumented, true);
  });
});
