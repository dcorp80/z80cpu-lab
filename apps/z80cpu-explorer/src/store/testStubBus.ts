// Minimal stub of the bus surface the store consumes. Tests stage
// `lastMem*` / `lastIo*` via the `setLast*` helpers to simulate "the
// CPU just did X" before firing a pause through the stub loop.

import type { BusAccessRecord } from "../runloop/bus.ts";

export interface StubBus {
  mem: Uint8Array;
  io: Uint8Array;
  intVector(): number;
  setIntVector(byte: number): void;
  broadcastIoLowByte(port: number, value: number): void;
  lastMemRead(): BusAccessRecord | null;
  lastMemWrite(): BusAccessRecord | null;
  lastIoRead(): BusAccessRecord | null;
  lastIoWrite(): BusAccessRecord | null;
  // Test-only stagers.
  setLastMemRead(r: BusAccessRecord | null): void;
  setLastMemWrite(r: BusAccessRecord | null): void;
  setLastIoRead(r: BusAccessRecord | null): void;
  setLastIoWrite(r: BusAccessRecord | null): void;
}

export function makeStubBus(): StubBus {
  let v = 0xff;
  const mem = new Uint8Array(0x10000).fill(0xff);
  const io = new Uint8Array(0x10000).fill(0xff);
  let lastMR: BusAccessRecord | null = null;
  let lastMW: BusAccessRecord | null = null;
  let lastIR: BusAccessRecord | null = null;
  let lastIW: BusAccessRecord | null = null;
  return {
    mem,
    io,
    intVector: () => v,
    setIntVector: (b: number) => {
      v = b & 0xff;
    },
    broadcastIoLowByte: (port: number, value: number) => {
      const p = port & 0xff;
      const val = value & 0xff;
      for (let hi = 0; hi < 256; hi++) {
        io[(hi << 8) | p] = val;
      }
    },
    lastMemRead: () => lastMR,
    lastMemWrite: () => lastMW,
    lastIoRead: () => lastIR,
    lastIoWrite: () => lastIW,
    setLastMemRead: (r) => {
      lastMR = r;
    },
    setLastMemWrite: (r) => {
      lastMW = r;
    },
    setLastIoRead: (r) => {
      lastIR = r;
    },
    setLastIoWrite: (r) => {
      lastIW = r;
    },
  };
}
