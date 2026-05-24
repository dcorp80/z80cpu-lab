// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// z80disasm.ts
//
// Z80 disassembler. Stateless, dependency-free. Designed to be called on
// byte windows from dbg traces or any other source.
//
// Empty input returns { text: "", length: 0 }.
// Lone prefix bytes ([0xDD] / [0xFD] / [0xED] / [0xCB]) return their hex
// representation per STYLE.orphanPrefix — that matches how the dbg surfaces
// wasted prefix M1 cycles.
//
// All user-visible text and number formatting lives in STYLE at the top of
// the file. Restyle the entire output by editing only that object.

export interface Disasm {
  text: string;
  length: number; // bytes actually consumed
  undocumented?: true;
  rel?: number; // signed JR/DJNZ displacement (added to PC AFTER the instruction)
  abs?: number; // absolute 16-bit address (CALL nn, JP nn, LD (nn),...)
  indexD?: number; // signed (IX+d)/(IY+d) byte for indexed addressing
}

// ─── Style: all user-visible text ───────────────────────────────────────────

const STYLE = {
  // Number formatting
  hex8: (n: number) => `${n.toString(16).toUpperCase().padStart(2, "0")}h`,
  hex16: (n: number) => `${n.toString(16).toUpperCase().padStart(4, "0")}h`,
  // Signed displacement for "JR e" — shows "+5" / "-3" style
  signedDec: (s: number) => (s >= 0 ? "+" : "") + s.toString(),
  // Indexed operand: "(IX+05h)" — uses signed hex
  idx: (reg: "IX" | "IY", d: number) => {
    const s = d & 0x80 ? d - 0x100 : d;
    const sign = s >= 0 ? "+" : "-";
    return `(${reg}${sign}${STYLE.hex8(Math.abs(s))})`;
  },

  // Register / condition tables (indexed by opcode field)
  r: ["B", "C", "D", "E", "H", "L", "(HL)", "A"],
  rp: ["BC", "DE", "HL", "SP"],
  rp2: ["BC", "DE", "HL", "AF"],
  cc: ["NZ", "Z", "NC", "C", "PO", "PE", "P", "M"],
  alu: ["ADD A,", "ADC A,", "SUB ", "SBC A,", "AND ", "XOR ", "OR ", "CP "],
  rot: ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"],

  // IX/IY-substituted register names
  idxH: { IX: "IXH", IY: "IYH" } as const,
  idxL: { IX: "IXL", IY: "IYL" } as const,

  // Block ops (ED A0..BF) — indexed by ((y-4) << 2) | z  with y∈[4..7], z∈[0..3]
  block: [
    "LDI",
    "CPI",
    "INI",
    "OUTI",
    "LDD",
    "CPD",
    "IND",
    "OUTD",
    "LDIR",
    "CPIR",
    "INIR",
    "OTIR",
    "LDDR",
    "CPDR",
    "INDR",
    "OTDR",
  ],

  // Standalone mnemonics
  nop: "NOP",
  halt: "HALT",
  rlca: "RLCA",
  rrca: "RRCA",
  rla: "RLA",
  rra: "RRA",
  daa: "DAA",
  cpl: "CPL",
  scf: "SCF",
  ccf: "CCF",
  ret: "RET",
  reti: "RETI",
  retn: "RETN",
  exx: "EXX",
  exAfAfP: "EX AF,AF'",
  exDeHl: "EX DE,HL",
  exSpHl: "EX (SP),HL",
  di: "DI",
  ei: "EI",
  jpHl: "JP (HL)",
  ldSpHl: "LD SP,HL",
  djnz: "DJNZ",
  jr: "JR",
  jp: "JP",
  call: "CALL",
  rst: "RST",
  pop: "POP",
  push: "PUSH",
  ld: "LD",
  inc: "INC",
  dec: "DEC",
  add: "ADD",
  adc: "ADC",
  sbc: "SBC",
  in_: "IN",
  out: "OUT",
  neg: "NEG",
  im: "IM",
  ldIA: "LD I,A",
  ldRA: "LD R,A",
  ldAI: "LD A,I",
  ldAR: "LD A,R",
  rrd: "RRD",
  rld: "RLD",
  bit: "BIT",
  res: "RES",
  set: "SET",

  // Lone prefix byte (orphan from dbg's wasted-prefix split)
  orphanPrefix: (b: number) => STYLE.hex8(b),

  // Placeholder for a missing operand byte
  incomplete: "??",
} as const;

// ─── Cursor ─────────────────────────────────────────────────────────────────

class Cursor {
  pos = 0;
  readonly bytes: ArrayLike<number>;
  constructor(bytes: ArrayLike<number>) {
    this.bytes = bytes;
  }
  get done(): boolean {
    return this.pos >= this.bytes.length;
  }
  /** Return next byte or null if out of input. */
  nextByte(): number | null {
    if (this.done) return null;
    return this.bytes[this.pos++] & 0xff;
  }
  /** Little-endian 16-bit; partial reads yield null. */
  nextWord(): number | null {
    const lo = this.nextByte();
    const hi = this.nextByte();
    if (lo === null || hi === null) return null;
    return ((hi << 8) | lo) & 0xffff;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type Idx = "IX" | "IY" | null;

/** Format r[z] under an optional IX/IY prefix and (HL)-conflict rule. */
function rSub(z: number, idx: Idx, d: number, keepHL: boolean): string {
  if (idx === null) return STYLE.r[z];
  if (z === 6) return STYLE.idx(idx, d);
  if (z === 4) return keepHL ? "H" : STYLE.idxH[idx];
  if (z === 5) return keepHL ? "L" : STYLE.idxL[idx];
  return STYLE.r[z];
}

/** Format rp[p] under IX/IY prefix: HL slot becomes IX/IY. */
function rpSub(p: number, idx: Idx): string {
  return idx !== null && p === 2 ? idx : STYLE.rp[p];
}

/** Format rp2[p] under IX/IY prefix: HL slot becomes IX/IY. */
function rp2Sub(p: number, idx: Idx): string {
  return idx !== null && p === 2 ? idx : STYLE.rp2[p];
}

/** Consume an "n" operand. */
function readN(c: Cursor): string {
  const n = c.nextByte();
  return n === null ? STYLE.incomplete : STYLE.hex8(n);
}

/** Consume an "nn" operand; return [text, absValue|null]. */
function readNN(c: Cursor): { text: string; abs: number | null } {
  const nn = c.nextWord();
  return nn === null
    ? { text: STYLE.incomplete, abs: null }
    : { text: STYLE.hex16(nn), abs: nn };
}

/** Consume a signed "e" displacement (used by JR/DJNZ). */
function readE(c: Cursor): { text: string; rel: number | null } {
  const e = c.nextByte();
  if (e === null) return { text: STYLE.incomplete, rel: null };
  const s = e & 0x80 ? e - 0x100 : e;
  return { text: STYLE.signedDec(s), rel: s };
}

/** Consume a signed (IX+d) displacement. */
function readD(c: Cursor): { d: number; signed: number; complete: boolean } {
  const d = c.nextByte();
  if (d === null) return { d: 0, signed: 0, complete: false };
  return { d, signed: d & 0x80 ? d - 0x100 : d, complete: true };
}

// ─── Top-level disasm ───────────────────────────────────────────────────────

export function disasm(bytes: ArrayLike<number>): Disasm {
  if (bytes.length === 0) return { text: "", length: 0 };

  const c = new Cursor(bytes);
  let idx: Idx = null;
  let prefixWasted = false; // true if we discarded a DD/FD before ED/CB

  // Skip leading DD/FD prefixes; only the last one is effective. If a
  // wasted DD/FD precedes ED, ED resets the index latch (DD ED ≡ ED with
  // a wasted DD M1 on the chip). In all "wasted prefix" cases we flag
  // undocumented.
  while (true) {
    const b = c.nextByte();
    if (b === null) {
      // Bytes were nothing but DD/FD prefixes — render orphan.
      return { text: STYLE.orphanPrefix(bytes[0] & 0xff), length: c.pos };
    }
    if (b === 0xdd) {
      if (idx !== null) prefixWasted = true;
      idx = "IX";
      continue;
    }
    if (b === 0xfd) {
      if (idx !== null) prefixWasted = true;
      idx = "IY";
      continue;
    }

    // Not a DD/FD: this is the actual opcode (or ED/CB sub-prefix).
    if (b === 0xed) {
      if (idx !== null) {
        prefixWasted = true;
        idx = null;
      }
      const r = decodeED(c);
      if (prefixWasted) r.undocumented = true;
      r.length = c.pos;
      return r;
    }
    if (b === 0xcb) {
      const r = decodeCB(c, idx);
      if (prefixWasted) r.undocumented = true;
      r.length = c.pos;
      return r;
    }
    const r = decodeMain(c, b, idx);
    if (prefixWasted) r.undocumented = true;
    r.length = c.pos;
    return r;
  }
}

// ─── Main table (unprefixed + DD/FD substituted) ────────────────────────────

function decodeMain(c: Cursor, op: number, idx: Idx): Disasm {
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  // For opcodes that touch (HL)/(IX+d), the displacement byte comes BEFORE
  // any immediate. Read it lazily — only when we know the op needs one.
  let d = 0;
  let dRead = false;
  const ensureD = (): boolean => {
    if (dRead || idx === null) {
      dRead = true;
      return true;
    }
    const r = readD(c);
    d = r.d;
    dRead = true;
    return r.complete;
  };

  // Quadrant 1: LD r,r' (with HALT at 0x76)
  if (x === 1) {
    if (op === 0x76) {
      // DD/FD before HALT has no structural effect — prefix is wasted.
      const out: Disasm = { text: STYLE.halt, length: 0 };
      if (idx !== null) out.undocumented = true;
      return out;
    }
    // (HL)-conflict rule: when one slot is (HL)/(IX+d), the other H/L
    // stays plain. Only one of y, z can be 6 (we're not at 0x76).
    const idxSlot = idx !== null && (y === 6 || z === 6);
    if (idxSlot) ensureD();
    const keepY = idx !== null && z === 6; // dest is index → src H/L stays
    const keepZ = idx !== null && y === 6; // src is index → dest H/L stays
    const dst = rSub(y, idx, d, keepY);
    const src = rSub(z, idx, d, keepZ);
    const text = `${STYLE.ld} ${dst},${src}`;
    const undoc = idx !== null && !idxSlot; // DD before LD r,r' with no H/L slot ⇒ wasted
    const out: Disasm = { text, length: 0 };
    if (idxSlot) out.indexD = d & 0x80 ? d - 0x100 : d;
    // Also mark undocumented when we used IXH/IXL/IYH/IYL in either slot.
    if (idx !== null && !idxSlot) out.undocumented = true;
    else if (idx !== null && idxSlot) {
      // OK if the index slot is the only special, but if BOTH y and z
      // refer to a single-slot H/L (other than (HL)), that's undoc.
      // Here the conflict rule keeps H/L plain, so no IXH/IXL appears.
    }
    if (undoc) out.undocumented = true;
    return out;
  }

  // Quadrant 2: ALU r
  if (x === 2) {
    const idxSlot = idx !== null && z === 6;
    if (idxSlot) ensureD();
    const arg = rSub(z, idx, d, /*keepHL*/ false);
    const out: Disasm = { text: `${STYLE.alu[y]}${arg}`, length: 0 };
    if (idxSlot) out.indexD = d & 0x80 ? d - 0x100 : d;
    else if (idx !== null && (z === 4 || z === 5)) out.undocumented = true;
    else if (idx !== null && z !== 6 && !(z === 4 || z === 5))
      out.undocumented = true;
    return out;
  }

  // Quadrant 0: misc
  if (x === 0) {
    switch (z) {
      case 0: {
        if (y === 0)
          return mark(idx, { text: STYLE.nop, length: 0 }, idx !== null);
        if (y === 1)
          return mark(idx, { text: STYLE.exAfAfP, length: 0 }, idx !== null);
        if (y === 2) {
          const e = readE(c);
          const out: Disasm = { text: `${STYLE.djnz} ${e.text}`, length: 0 };
          if (e.rel !== null) out.rel = e.rel;
          if (idx !== null) out.undocumented = true;
          return out;
        }
        if (y === 3) {
          const e = readE(c);
          const out: Disasm = { text: `${STYLE.jr} ${e.text}`, length: 0 };
          if (e.rel !== null) out.rel = e.rel;
          if (idx !== null) out.undocumented = true;
          return out;
        }
        // y = 4..7 → JR cc[y-4],e
        const e = readE(c);
        const out: Disasm = {
          text: `${STYLE.jr} ${STYLE.cc[y - 4]},${e.text}`,
          length: 0,
        };
        if (e.rel !== null) out.rel = e.rel;
        if (idx !== null) out.undocumented = true;
        return out;
      }
      case 1: {
        if (q === 0) {
          // LD rp[p],nn
          const nn = readNN(c);
          const out: Disasm = {
            text: `${STYLE.ld} ${rpSub(p, idx)},${nn.text}`,
            length: 0,
          };
          if (nn.abs !== null) out.abs = nn.abs;
          if (idx !== null && p !== 2) out.undocumented = true;
          return out;
        } else {
          // ADD HL,rp[p]  → ADD IX/IY,rp (with HL slot also substituted)
          const dst = rpSub(2, idx);
          const src = rpSub(p, idx);
          return { text: `${STYLE.add} ${dst},${src}`, length: 0 };
        }
      }
      case 2: {
        // q=0: LD (BC)/(DE)/(nn),A or LD (nn),HL
        // q=1: LD A,(BC)/(DE)/(nn) or LD HL,(nn)
        if (q === 0) {
          if (p === 0)
            return mark(
              idx,
              { text: `${STYLE.ld} (BC),A`, length: 0 },
              idx !== null,
            );
          if (p === 1)
            return mark(
              idx,
              { text: `${STYLE.ld} (DE),A`, length: 0 },
              idx !== null,
            );
          if (p === 2) {
            const nn = readNN(c);
            const out: Disasm = {
              text: `${STYLE.ld} (${nn.text}),${rpSub(2, idx)}`,
              length: 0,
            };
            if (nn.abs !== null) out.abs = nn.abs;
            return out;
          }
          // p===3
          const nn = readNN(c);
          const out: Disasm = { text: `${STYLE.ld} (${nn.text}),A`, length: 0 };
          if (nn.abs !== null) out.abs = nn.abs;
          if (idx !== null) out.undocumented = true;
          return out;
        } else {
          if (p === 0)
            return mark(
              idx,
              { text: `${STYLE.ld} A,(BC)`, length: 0 },
              idx !== null,
            );
          if (p === 1)
            return mark(
              idx,
              { text: `${STYLE.ld} A,(DE)`, length: 0 },
              idx !== null,
            );
          if (p === 2) {
            const nn = readNN(c);
            const out: Disasm = {
              text: `${STYLE.ld} ${rpSub(2, idx)},(${nn.text})`,
              length: 0,
            };
            if (nn.abs !== null) out.abs = nn.abs;
            return out;
          }
          const nn = readNN(c);
          const out: Disasm = { text: `${STYLE.ld} A,(${nn.text})`, length: 0 };
          if (nn.abs !== null) out.abs = nn.abs;
          if (idx !== null) out.undocumented = true;
          return out;
        }
      }
      case 3: {
        // q=0: INC rp[p]; q=1: DEC rp[p]
        const mnem = q === 0 ? STYLE.inc : STYLE.dec;
        const out: Disasm = { text: `${mnem} ${rpSub(p, idx)}`, length: 0 };
        if (idx !== null && p !== 2) out.undocumented = true;
        return out;
      }
      case 4:
      case 5: {
        // INC r[y] / DEC r[y]
        const mnem = z === 4 ? STYLE.inc : STYLE.dec;
        const idxSlot = idx !== null && y === 6;
        if (idxSlot) ensureD();
        const arg = rSub(y, idx, d, /*keepHL*/ false);
        const out: Disasm = { text: `${mnem} ${arg}`, length: 0 };
        if (idxSlot) out.indexD = d & 0x80 ? d - 0x100 : d;
        else if (idx !== null && (y === 4 || y === 5)) out.undocumented = true;
        else if (idx !== null && y !== 6) out.undocumented = true;
        return out;
      }
      case 6: {
        // LD r[y],n
        const idxSlot = idx !== null && y === 6;
        if (idxSlot) ensureD();
        const n = readN(c);
        const dst = rSub(y, idx, d, /*keepHL*/ false);
        const out: Disasm = { text: `${STYLE.ld} ${dst},${n}`, length: 0 };
        if (idxSlot) out.indexD = d & 0x80 ? d - 0x100 : d;
        else if (idx !== null && (y === 4 || y === 5)) out.undocumented = true;
        else if (idx !== null && y !== 6) out.undocumented = true;
        return out;
      }
      case 7: {
        const z7 = [
          STYLE.rlca,
          STYLE.rrca,
          STYLE.rla,
          STYLE.rra,
          STYLE.daa,
          STYLE.cpl,
          STYLE.scf,
          STYLE.ccf,
        ];
        return mark(idx, { text: z7[y], length: 0 }, idx !== null);
      }
    }
  }

  // Quadrant 3
  // x === 3
  switch (z) {
    case 0: {
      const out: Disasm = { text: `${STYLE.ret} ${STYLE.cc[y]}`, length: 0 };
      if (idx !== null) out.undocumented = true;
      return out;
    }
    case 1: {
      if (q === 0) {
        const out: Disasm = {
          text: `${STYLE.pop} ${rp2Sub(p, idx)}`,
          length: 0,
        };
        if (idx !== null && p !== 2) out.undocumented = true;
        return out;
      }
      if (p === 0)
        return mark(idx, { text: STYLE.ret, length: 0 }, idx !== null);
      if (p === 1)
        return mark(idx, { text: STYLE.exx, length: 0 }, idx !== null);
      if (p === 2) return { text: `${STYLE.jp} (${idx ?? "HL"})`, length: 0 };
      // p === 3
      return { text: `${STYLE.ld} SP,${idx ?? "HL"}`, length: 0 };
    }
    case 2: {
      const nn = readNN(c);
      const out: Disasm = {
        text: `${STYLE.jp} ${STYLE.cc[y]},${nn.text}`,
        length: 0,
      };
      if (nn.abs !== null) out.abs = nn.abs;
      if (idx !== null) out.undocumented = true;
      return out;
    }
    case 3: {
      // y=0: JP nn (CB/DD/ED/FD prefixes handled in disasm() before reaching here)
      if (y === 0) {
        const nn = readNN(c);
        const out: Disasm = { text: `${STYLE.jp} ${nn.text}`, length: 0 };
        if (nn.abs !== null) out.abs = nn.abs;
        if (idx !== null) out.undocumented = true;
        return out;
      }
      // y=1 (CB), y=5 (DD), y=6 (ED), y=7 (FD) are handled by disasm()
      if (y === 2) {
        const n = readN(c);
        const out: Disasm = { text: `${STYLE.out} (${n}),A`, length: 0 };
        if (idx !== null) out.undocumented = true;
        return out;
      }
      if (y === 3) {
        const n = readN(c);
        const out: Disasm = { text: `${STYLE.in_} A,(${n})`, length: 0 };
        if (idx !== null) out.undocumented = true;
        return out;
      }
      if (y === 4)
        return {
          text: `${STYLE.exSpHl.replace("HL", idx ?? "HL")}`,
          length: 0,
        };
      if (y === 5)
        return mark(idx, { text: STYLE.exDeHl, length: 0 }, idx !== null);
      if (y === 6)
        return mark(idx, { text: STYLE.di, length: 0 }, idx !== null);
      return mark(idx, { text: STYLE.ei, length: 0 }, idx !== null);
    }
    case 4: {
      const nn = readNN(c);
      const out: Disasm = {
        text: `${STYLE.call} ${STYLE.cc[y]},${nn.text}`,
        length: 0,
      };
      if (nn.abs !== null) out.abs = nn.abs;
      if (idx !== null) out.undocumented = true;
      return out;
    }
    case 5: {
      if (q === 0) {
        const out: Disasm = {
          text: `${STYLE.push} ${rp2Sub(p, idx)}`,
          length: 0,
        };
        if (idx !== null && p !== 2) out.undocumented = true;
        return out;
      }
      if (p === 0) {
        const nn = readNN(c);
        const out: Disasm = { text: `${STYLE.call} ${nn.text}`, length: 0 };
        if (nn.abs !== null) out.abs = nn.abs;
        if (idx !== null) out.undocumented = true;
        return out;
      }
      // p=1/2/3 are DD/ED/FD prefixes — handled by disasm() before we reach here
      // Defensive fallback (shouldn't reach):
      return { text: STYLE.nop, length: 0, undocumented: true };
    }
    case 6: {
      // alu[y] n
      const n = readN(c);
      const out: Disasm = { text: `${STYLE.alu[y]}${n}`, length: 0 };
      if (idx !== null) out.undocumented = true;
      return out;
    }
    case 7: {
      const out: Disasm = {
        text: `${STYLE.rst} ${STYLE.hex8(y * 8)}`,
        length: 0,
      };
      if (idx !== null) out.undocumented = true;
      return out;
    }
  }

  return { text: STYLE.nop, length: 0, undocumented: true }; // unreachable
}

/** Apply `undocumented: true` if `flag` is set. Used for opcodes whose DD/FD
 *  prefix has no structural effect (and thus the prefix is "wasted"). */
function mark(_idx: Idx, out: Disasm, flag: boolean): Disasm {
  if (flag) out.undocumented = true;
  return out;
}

// ─── CB-prefixed ────────────────────────────────────────────────────────────

function decodeCB(c: Cursor, idx: Idx): Disasm {
  // DDCB / FDCB form: displacement comes BEFORE the sub-opcode.
  let d = 0;
  let dSigned = 0;
  let indexed = false;
  if (idx !== null) {
    const r = readD(c);
    d = r.d;
    dSigned = r.signed;
    indexed = true;
  }
  const op = c.nextByte();
  if (op === null) return { text: STYLE.incomplete, length: 0 };

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  // For DDCB/FDCB: the operand is (IX+d)/(IY+d). For x≠1 with z≠6, the
  // undocumented r-write form ALSO writes the result to r[z].
  const idxOp = indexed ? STYLE.idx(idx as "IX" | "IY", d) : null;

  if (x === 0) {
    // rot[y] r[z]  (or rot[y] (IX+d) for indexed)
    let text: string;
    let undoc = y === 6; // SLL (z80-undocumented)
    if (indexed) {
      if (z === 6) {
        text = `${STYLE.rot[y]} ${idxOp}`;
      } else {
        // Undocumented: rotate (IX+d), store into r[z] too
        text = `${STYLE.rot[y]} ${STYLE.r[z]},${idxOp}`;
        undoc = true;
      }
    } else {
      text = `${STYLE.rot[y]} ${STYLE.r[z]}`;
    }
    const out: Disasm = { text, length: 0 };
    if (indexed) out.indexD = dSigned;
    if (undoc) out.undocumented = true;
    return out;
  }

  // x = 1 (BIT), 2 (RES), 3 (SET)
  const mnem = x === 1 ? STYLE.bit : x === 2 ? STYLE.res : STYLE.set;
  let text: string;
  let undoc = false;
  if (indexed) {
    if (x === 1) {
      // BIT y,(IX+d) — z is ignored on hardware; non-(HL) z is undocumented form
      text = `${mnem} ${y},${idxOp}`;
      if (z !== 6) undoc = true;
    } else {
      if (z === 6) {
        text = `${mnem} ${y},${idxOp}`;
      } else {
        text = `${mnem} ${y},${STYLE.r[z]},${idxOp}`;
        undoc = true;
      }
    }
  } else {
    text = `${mnem} ${y},${STYLE.r[z]}`;
  }
  const out: Disasm = { text, length: 0 };
  if (indexed) out.indexD = dSigned;
  if (undoc) out.undocumented = true;
  return out;
}

// ─── ED-prefixed ────────────────────────────────────────────────────────────

function decodeED(c: Cursor): Disasm {
  const op = c.nextByte();
  if (op === null) return { text: STYLE.incomplete, length: 0 };

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  // ED is documented only in quadrants 1 (x=1) and 2 (x=2, y>=4, z<=3).
  // Everything else is "ED NOP" — undocumented.

  if (x === 1) {
    switch (z) {
      case 0: {
        // IN r[y],(C); y=6 is undocumented "IN (C)" / "IN F,(C)"
        if (y === 6) {
          return { text: `${STYLE.in_} (C)`, length: 0, undocumented: true };
        }
        return { text: `${STYLE.in_} ${STYLE.r[y]},(C)`, length: 0 };
      }
      case 1: {
        // OUT (C),r[y]; y=6 is undocumented "OUT (C),0"
        if (y === 6) {
          return { text: `${STYLE.out} (C),0`, length: 0, undocumented: true };
        }
        return { text: `${STYLE.out} (C),${STYLE.r[y]}`, length: 0 };
      }
      case 2: {
        // q=0: SBC HL,rp[p]   q=1: ADC HL,rp[p]
        const mnem = q === 0 ? STYLE.sbc : STYLE.adc;
        return { text: `${mnem} HL,${STYLE.rp[p]}`, length: 0 };
      }
      case 3: {
        // q=0: LD (nn),rp[p]   q=1: LD rp[p],(nn)
        const nn = readNN(c);
        const text =
          q === 0
            ? `${STYLE.ld} (${nn.text}),${STYLE.rp[p]}`
            : `${STYLE.ld} ${STYLE.rp[p]},(${nn.text})`;
        const out: Disasm = { text, length: 0 };
        if (nn.abs !== null) out.abs = nn.abs;
        return out;
      }
      case 4: {
        // NEG; only y=0 is documented, others are undocumented copies
        const out: Disasm = { text: STYLE.neg, length: 0 };
        if (y !== 0) out.undocumented = true;
        return out;
      }
      case 5: {
        // RETN / RETI
        // Officially: y=1 is RETI, all others are RETN.
        // y=1 (op 0x4D) is RETI, others are RETN — but undocumented variants.
        if (y === 1) return { text: STYLE.reti, length: 0 };
        const out: Disasm = { text: STYLE.retn, length: 0 };
        if (y !== 0) out.undocumented = true;
        return out;
      }
      case 6: {
        // IM x — y selects mode. Documented: y=0,2,3 → IM 0/1/2; others undoc.
        const mode = [0, 0, 1, 2, 0, 0, 1, 2][y];
        const out: Disasm = { text: `${STYLE.im} ${mode}`, length: 0 };
        if (y === 1 || y === 4 || y === 5 || y === 6 || y === 7)
          out.undocumented = true;
        return out;
      }
      case 7: {
        // Misc: LD I,A / LD R,A / LD A,I / LD A,R / RRD / RLD / NOP / NOP
        const tbl = [
          STYLE.ldIA,
          STYLE.ldRA,
          STYLE.ldAI,
          STYLE.ldAR,
          STYLE.rrd,
          STYLE.rld,
          STYLE.nop,
          STYLE.nop,
        ];
        const out: Disasm = { text: tbl[y], length: 0 };
        if (y === 6 || y === 7) out.undocumented = true;
        return out;
      }
    }
  }

  if (x === 2 && y >= 4 && z <= 3) {
    // Block ops: y∈[4..7], z∈[0..3]
    return { text: STYLE.block[((y - 4) << 2) | z], length: 0 };
  }

  // Everything else: undocumented ED-NOP. Text is plain "NOP".
  return { text: STYLE.nop, length: 0, undocumented: true };
}
