// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// Capture observable Z80 state into a stable shape for golden comparison.
//
// All architectural register state plus a SHA-256 of memory and IO. Hashes
// keep snapshot files small and diffs readable; for debugging drift, a
// follow-up pass can dump the full mem/io to .bin sidecars.

import { createHash } from "node:crypto";
import type { Z80Cpu } from "@dcorp80/z80cpu";
import {
  A,
  A_,
  B,
  B_,
  C,
  C_,
  D,
  D_,
  E,
  E_,
  H,
  H_,
  IXH,
  IXL,
  IYH,
  IYL,
  L,
  L_,
} from "@dcorp80/z80cpu";

export interface Snapshot {
  pc: number;
  sp: number;
  wz: number;
  i: number;
  r: number; // observable R: low 7 bits of regs.r OR'd with bit-7 from r7
  af: number;
  bc: number;
  de: number;
  hl: number;
  afp: number; // AF'
  bcp: number;
  dep: number;
  hlp: number;
  ix: number;
  iy: number;
  iff1: number;
  iff2: number;
  im: 0 | 1 | 2;
  hc: number;
  instructions: number;
  memSha256: string;
  ioSha256: string;
}

export function snapshot(
  cpu: Z80Cpu,
  mem: Array<number>,
  io: Array<number>,
  hc: number,
  instructions: number,
): Snapshot {
  const f = cpu.regs.file;
  const af = (f[A] << 8) | (cpu.regs.f[0] & 0xff);
  const afp = (f[A_] << 8) | (cpu.regs.f[1] & 0xff);
  const bc = (f[B] << 8) | f[C];
  const de = (f[D] << 8) | f[E];
  const hl = (f[H] << 8) | f[L];
  const bcp = (f[B_] << 8) | f[C_];
  const dep = (f[D_] << 8) | f[E_];
  const hlp = (f[H_] << 8) | f[L_];
  const ix = (f[IXH] << 8) | f[IXL];
  const iy = (f[IYH] << 8) | f[IYL];
  const r = ((cpu.regs.r & 0x7f) | (cpu.regs.r7 & 0x80)) & 0xff;
  const im: 0 | 1 | 2 = cpu.ctl.imFa === 0 ? 0 : cpu.ctl.imFb === 0 ? 1 : 2;

  return {
    pc: cpu.regs.pc,
    sp: cpu.regs.sp,
    wz: cpu.regs.wz,
    i: cpu.regs.i,
    r,
    af,
    bc,
    de,
    hl,
    afp,
    bcp,
    dep,
    hlp,
    ix,
    iy,
    iff1: cpu.ctl.iff1,
    iff2: cpu.ctl.iff2,
    im,
    hc,
    instructions,
    memSha256: createHash("sha256").update(Buffer.from(mem)).digest("hex"),
    ioSha256: createHash("sha256").update(Buffer.from(io)).digest("hex"),
  };
}
