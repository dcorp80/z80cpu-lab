// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// z80-preamble.ts — Generate Z80 instruction preambles to set CPU registers.
//
// This module builds the shortest instruction sequence
// that achieves a desired register setup and writes it
// into the test memory buffer starting at address 0x00.
//
// Usage:
//   const { p, hc } = preamble(mem, { a: 0x42, b: 0x11, f: 0x00, sp: 0xFFFE });
//   mem[p] = opcode;  // place the instruction under test after the preamble
//   tickN(cpu, resolve, hc + instrHC);

// ── Register setup descriptor ────────────────────────────────────

export interface RegSetup {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  h?: number;
  l?: number;
  f?: number;
  sp?: number;
  ix?: number;
  iy?: number;
  i?: number;
  r?: number;
  // Alternate register set
  a2?: number;
  f2?: number;
  b2?: number;
  c2?: number;
  d2?: number;
  e2?: number;
  h2?: number;
  l2?: number;
  // Interrupt control
  ei?: boolean; // true → EI, false → DI
  im?: 0 | 1 | 2; // interrupt mode
}

export interface PreambleResult {
  p: number; // byte offset where the test instruction should be placed
  hc: number; // half-cycle cost of the preamble
  pfx: number; // post-preamble prefix state (bit 0=exAf, bit 1=exx)
}

// ── Scratch area addresses for POP AF ────────────────────────────
// Must not collide with preamble code (starts at 0x00, ≤ ~60 bytes)
// or typical test data areas (0x50–0x80).  0xF0 is safe for 256-byte mem.
// SCRATCH_ALT is for loading alternate AF (step 3b); SCRATCH is for main AF
// (step 6).  Separate addresses prevent step 6's code-gen writes from
// overwriting step 3b's data before the Z80 executes.
const SCRATCH = 0xfe;
const SCRATCH_ALT = 0xfc;

// ── Opcode constants ─────────────────────────────────────────────
const LD_B_N = 0x06,
  LD_C_N = 0x0e,
  LD_D_N = 0x16,
  LD_E_N = 0x1e;
const LD_H_N = 0x26,
  LD_L_N = 0x2e,
  LD_A_N = 0x3e;
const LD_BC_NN = 0x01;
const LD_DE_NN = 0x11;
const LD_HL_NN = 0x21;
const LD_SP_NN = 0x31;
const EX_AF = 0x08;
const EXX = 0xd9;
const POP_AF = 0xf1;
const EI = 0xfb;
const DI = 0xf3;
const PREFIX_ED = 0xed;
const PREFIX_DD = 0xdd;
const PREFIX_FD = 0xfd;
const LD_I_A = 0x47; // ED 47
const LD_R_A = 0x4f; // ED 4F
const IM_0 = 0x46; // ED 46
const IM_1 = 0x56; // ED 56
const IM_2 = 0x5e; // ED 5E
const LD_IX_NN = 0x21; // DD 21 lo hi
const LD_IY_NN = 0x21; // FD 21 lo hi

// ── HC costs (half-cycles) ───────────────────────────────────────
const HC_LD_R_N = 14; // LD r, n — M1(8) + opRd(6)
const HC_LD_RR_NN = 20; // LD rr, nn — M1(8) + opRd(6) + opRd(6)
const HC_LD_SP_NN = 20; // LD SP, nn — M1(8) + opRd(6) + opRd(6)
const HC_LD_IXIY_NN = 28; // DD/FD 21 nn — prefix(8) + M1(8) + opRd(6) + opRd(6)
const HC_POP_AF = 20; // POP AF — M1(8) + mRd(6) + mRd(6)
const HC_EX_AF = 8; // EX AF,AF' — M1(8)
const HC_EXX = 8; // EXX — M1(8)
const HC_EI_DI = 8; // EI/DI — M1(8)
const HC_LD_I_A = 18; // ED 47 — prefix(8) + M1 extra(2) + internal(8)... actually 2 M1 cycles
const _HC_LD_R_A = 18; // ED 4F — prefix(8) + M1 extra(2) + internal(8)... actually 2 M1 cycles
// LD I,A is ED prefix (4T=8HC) + opcode (5T=10HC) = 9T = 18HC total? Let me check.
// Actually: ED prefix = M1(4T), LD I,A = M1(5T) = total 9T = 18HC
const HC_IM_N = 16; // ED 46/56/5E — prefix M1(4T=8HC) + opcode M1(4T=8HC)

// ── Main function ────────────────────────────────────────────────

// `at` shifts the preamble's start address. When `at > 0`, callers must leave
// mem[0..at-1] as 0x00 (NOP) so the CPU executes through them to reach the
// preamble. Each filler NOP costs 8 HC and is included in the returned `hc`.
// Use this when the default 0x0000 layout collides with a fixed entry point
// (e.g. INT vector 0x0038, NMI 0x0066) that must hold specific code.
export function preamble(
  mem: Uint8Array,
  setup: RegSetup,
  at: number = 0,
): PreambleResult {
  let p = at; // current write position in mem
  let hc = at * 8; // filler NOPs from 0x0000 to `at-1`, 8 HC each
  const pfx = 0; // prefix state tracking

  // Resolve effective values: default all main registers + F + SP to 0
  const b = setup.b ?? 0;
  const c = setup.c ?? 0;
  const d = setup.d ?? 0;
  const e = setup.e ?? 0;
  const h = setup.h ?? 0;
  const l = setup.l ?? 0;
  const a = setup.a ?? 0;
  const f = setup.f ?? 0;
  const sp = setup.sp ?? 0;

  const hasAltBCDEHL =
    setup.b2 !== undefined ||
    setup.c2 !== undefined ||
    setup.d2 !== undefined ||
    setup.e2 !== undefined ||
    setup.h2 !== undefined ||
    setup.l2 !== undefined;
  const hasAltAF = setup.a2 !== undefined || setup.f2 !== undefined;

  // ── 1. Interrupt mode (before anything else, doesn't touch registers) ──
  if (setup.im !== undefined) {
    mem[p++] = PREFIX_ED;
    mem[p++] = setup.im === 0 ? IM_0 : setup.im === 1 ? IM_1 : IM_2;
    hc += HC_IM_N;
  }

  // ── 2. I register: LD A,n + LD I,A (clobbers A — must come before real A) ──
  if (setup.i !== undefined) {
    mem[p++] = LD_A_N;
    mem[p++] = setup.i & 0xff;
    hc += HC_LD_R_N;
    mem[p++] = PREFIX_ED;
    mem[p++] = LD_I_A;
    hc += HC_LD_I_A;
  }

  // ── 2a. R register: LD A,n + LD R,A (clobbers A — must come before real A) ──
  if (setup.r !== undefined) {
    mem[p++] = LD_A_N;
    mem[p++] = setup.r & 0xff;
    hc += HC_LD_R_N;
    mem[p++] = PREFIX_ED;
    mem[p++] = LD_R_A;
    hc += HC_LD_I_A;
  }

  // ── 3. Alternate registers ──
  // Strategy: Swap, load desired alt values into main regs, then swap into shadow.
  if (hasAltBCDEHL || hasAltAF) {
    // 3a. Load B'-L' values into main B-L
    if (hasAltBCDEHL) {
      mem[p++] = EXX;
      hc += HC_EXX;
      if (setup.b2 !== undefined) {
        mem[p++] = LD_B_N;
        mem[p++] = setup.b2 & 0xff;
        hc += HC_LD_R_N;
      }
      if (setup.c2 !== undefined) {
        mem[p++] = LD_C_N;
        mem[p++] = setup.c2 & 0xff;
        hc += HC_LD_R_N;
      }
      if (setup.d2 !== undefined) {
        mem[p++] = LD_D_N;
        mem[p++] = setup.d2 & 0xff;
        hc += HC_LD_R_N;
      }
      if (setup.e2 !== undefined) {
        mem[p++] = LD_E_N;
        mem[p++] = setup.e2 & 0xff;
        hc += HC_LD_R_N;
      }
      if (setup.h2 !== undefined) {
        mem[p++] = LD_H_N;
        mem[p++] = setup.h2 & 0xff;
        hc += HC_LD_R_N;
      }
      if (setup.l2 !== undefined) {
        mem[p++] = LD_L_N;
        mem[p++] = setup.l2 & 0xff;
        hc += HC_LD_R_N;
      }
      mem[p++] = EXX;
      hc += HC_EXX;
    }

    // 3b. Load A'/F' via POP AF into main AF
    if (hasAltAF) {
      mem[p++] = EX_AF;
      hc += HC_EX_AF;
      const aVal = setup.a2 ?? 0;
      const fVal = setup.f2 ?? 0;
      mem[SCRATCH_ALT] = fVal & 0xff; // F at (SP)
      mem[SCRATCH_ALT + 1] = aVal & 0xff; // A at (SP+1)
      mem[p++] = LD_SP_NN;
      mem[p++] = SCRATCH_ALT & 0xff;
      mem[p++] = (SCRATCH_ALT >> 8) & 0xff;
      hc += HC_LD_SP_NN;
      mem[p++] = POP_AF;
      hc += HC_POP_AF;
      mem[p++] = EX_AF;
      hc += HC_EX_AF;
    }
  }

  // ── 4. Main registers B, C, D, E, H, L (always emitted via 16-bit LD) ──
  mem[p++] = LD_BC_NN;
  mem[p++] = c & 0xff;
  mem[p++] = b & 0xff;
  hc += HC_LD_RR_NN;
  mem[p++] = LD_DE_NN;
  mem[p++] = e & 0xff;
  mem[p++] = d & 0xff;
  hc += HC_LD_RR_NN;
  mem[p++] = LD_HL_NN;
  mem[p++] = l & 0xff;
  mem[p++] = h & 0xff;
  hc += HC_LD_RR_NN;

  // ── 5. IX / IY ──
  if (setup.ix !== undefined) {
    mem[p++] = PREFIX_DD;
    mem[p++] = LD_IX_NN;
    mem[p++] = setup.ix & 0xff;
    mem[p++] = (setup.ix >> 8) & 0xff;
    hc += HC_LD_IXIY_NN;
  }
  if (setup.iy !== undefined) {
    mem[p++] = PREFIX_FD;
    mem[p++] = LD_IY_NN;
    mem[p++] = setup.iy & 0xff;
    mem[p++] = (setup.iy >> 8) & 0xff;
    hc += HC_LD_IXIY_NN;
  }

  // ── 6. A and F (always emitted via POP AF) ──
  mem[SCRATCH] = f & 0xff; // F at (SP)
  mem[SCRATCH + 1] = a & 0xff; // A at (SP+1)
  mem[p++] = LD_SP_NN;
  mem[p++] = SCRATCH & 0xff;
  mem[p++] = (SCRATCH >> 8) & 0xff;
  hc += HC_LD_SP_NN;
  mem[p++] = POP_AF;
  hc += HC_POP_AF;

  // ── 7. SP (always emitted — POP AF above clobbers it) ──
  mem[p++] = LD_SP_NN;
  mem[p++] = sp & 0xff;
  mem[p++] = (sp >> 8) & 0xff;
  hc += HC_LD_SP_NN;

  // ── 8. EI/DI — goes last (EI has 1-instruction delay before IFF takes effect) ──
  if (setup.ei === true) {
    mem[p++] = EI;
    hc += HC_EI_DI;
  } else if (setup.ei === false) {
    mem[p++] = DI;
    hc += HC_EI_DI;
  }

  return { p, hc, pfx };
}
