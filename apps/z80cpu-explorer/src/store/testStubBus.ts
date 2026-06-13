// Minimal stub of the bus surface the store consumes. Tests stage
// `lastMem*` / `lastIo*` via the `setLast*` helpers to simulate "the
// CPU just did X" before firing a pause through the stub loop.
//
// Mirrors the real bus's split-IO shape (REQ §11): `ioRead` is always
// present, `ioWrite` is allocated only when the `splitIo` option is on.
// Joined-mode tests get the default single-plane stub; split-mode tests
// pass `makeStubBus({ splitIo: true })` to exercise the dual-plane path.

import type { BusAccessRecord, InputPinName } from "../runloop/bus.ts";

export interface StubBus {
  mem: Uint8Array;
  ioRead: Uint8Array;
  ioWrite: Uint8Array | null;
  splitIo: boolean;
  memInit: number;
  ioInit: number;
  intVector(): number;
  setIntVector(byte: number): void;
  getInputPin(name: InputPinName): 0 | 1;
  setInputPin(name: InputPinName, value: 0 | 1): void;
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

export interface StubBusOptions {
  splitIo?: boolean;
}

export function makeStubBus(opts: StubBusOptions = {}): StubBus {
  let v = 0xff;
  const splitIo = opts.splitIo === true;
  const mem = new Uint8Array(0x10000).fill(0xff);
  const ioRead = new Uint8Array(0x10000).fill(0xff);
  const ioWrite = splitIo ? new Uint8Array(0x10000).fill(0xff) : null;
  let lastMR: BusAccessRecord | null = null;
  let lastMW: BusAccessRecord | null = null;
  let lastIR: BusAccessRecord | null = null;
  let lastIW: BusAccessRecord | null = null;
  const pins: Record<InputPinName, 0 | 1> = {
    nINT: 1,
    nNMI: 1,
    nRESET: 1,
    nBUSRQ: 1,
    nWAIT: 1,
  };
  return {
    mem,
    ioRead,
    ioWrite,
    splitIo,
    memInit: 0xff,
    ioInit: 0xff,
    intVector: () => v,
    setIntVector: (b: number) => {
      v = b & 0xff;
    },
    getInputPin: (name) => pins[name],
    setInputPin: (name, value) => {
      pins[name] = (value & 1) as 0 | 1;
    },
    broadcastIoLowByte: (port: number, value: number) => {
      const p = port & 0xff;
      const val = value & 0xff;
      for (let hi = 0; hi < 256; hi++) {
        ioRead[(hi << 8) | p] = val;
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
