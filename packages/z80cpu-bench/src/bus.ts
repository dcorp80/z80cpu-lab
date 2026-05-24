// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// 64KB memory + 64KB IO bus resolver for the mixer benchmark.
//
// Both spaces are symmetric: anything written can be read back. IO uses the
// full 16-bit address bus, so `IN A,(n)` sees `A:n` (Z80 puts A on the high
// byte during M2 of `IN A,(n)`/`OUT (n),A`), and `IN r,(C)` sees BC. This
// matches the real chip without any port-decoding logic.
//
// Construction zeroes both spaces; the test loads the program into mem before
// ticking the CPU.

import type { Z80Cpu } from "@dcorp80/z80cpu";

export const MEM_SIZE = 0x10000;
export const IO_SIZE = 0x10000;

export interface Bus64k {
  mem: Array<number>;
  io: Array<number>;
  resolve: () => void;
}

export function makeBus64k(cpu: Z80Cpu): Bus64k {
  const mem = new Array(MEM_SIZE);
  const io = new Array(IO_SIZE);
  const resolve = () => {
    const { nMREQ, nIORQ, nRD, nWR, addr, data } = cpu.bus;
    if (!nMREQ) {
      const a = (addr ?? 0) & 0xffff;
      if (!nRD) cpu.bus.data = mem[a];
      if (!nWR && data !== undefined) mem[a] = data;
    }
    if (!nIORQ) {
      const a = (addr ?? 0) & 0xffff;
      if (!nRD) cpu.bus.data = io[a];
      if (!nWR && data !== undefined) io[a] = data;
    }
  };
  return { mem, io, resolve };
}
