// 64K mem + 64K IO bus resolver with INT-ack injection. Per DESIGN §2.1
// duty 1 of busTick: on memory read/write resolve against mem[]; on IO
// read/write resolve against io[]; on INT acknowledge (`nM1` low +
// `nIORQ` low) place the configured INT vector byte on `cpu.bus.data`.
//
// Input pins are NOT applied here — level pins (`nINT`/`nRESET`/`nBUSRQ`/
// `nWAIT`) are written eagerly to `cpu.bus` by store actions (DESIGN
// §2.5), and `nNMI` is a momentary pulse driven by busTick (milestone 8).

import type { Z80Cpu } from "@dcorp80/z80cpu";
import type { BusConfig } from "../config/defaults.ts";

export const MEM_SIZE = 0x10000;
export const IO_SIZE = 0x10000;

/**
 * Snapshot of the most recent mem/IO read or write the bus resolved.
 * Used by the Memory and IO sections' folded summaries (REQ §6.6 / §6.7)
 * — the store samples these on `loop.onPause`, so they always reflect
 * what the CPU did before pausing, not stale per-edge churn during run.
 */
export interface BusAccessRecord {
  addr: number;
  value: number;
}

export interface Bus64k {
  mem: Uint8Array;
  io: Uint8Array;
  /** Byte placed on `cpu.bus.data` during INT-acknowledge cycles (REQ §6.4). */
  intVector(): number;
  /** Updates the INT vector. Value is masked to 8 bits at the boundary. */
  setIntVector(byte: number): void;
  resolve(): void;
  /**
   * Most recent mem/IO accesses, captured inside `resolve()`. Returns
   * `null` until the corresponding cycle has occurred at least once.
   * Each call allocates a fresh record so the caller can retain it
   * without aliasing the bus's internal state.
   */
  lastMemRead(): BusAccessRecord | null;
  lastMemWrite(): BusAccessRecord | null;
  lastIoRead(): BusAccessRecord | null;
  lastIoWrite(): BusAccessRecord | null;
}

export function makeBus64k(cpu: Z80Cpu, config: BusConfig): Bus64k {
  // Init bytes masked at the bus boundary (per validation-boundary rule —
  // a config value from a user-facing surface mustn't trust upstream masking).
  const memInit = config.memInit & 0xff;
  const ioInit = config.ioInit & 0xff;
  const mem = new Uint8Array(MEM_SIZE).fill(memInit);
  const io = new Uint8Array(IO_SIZE).fill(ioInit);
  // INT vector storage is owned by the bus, just like mem and io.
  // Accessors keep the byte authoritative inside the bus closure.
  let intVector = config.intVectorInit & 0xff;
  // Last-touched trackers — sentinel of -1 means "no such cycle yet,"
  // accessor returns null. Kept as plain numbers (not records) to keep
  // `resolve()` allocation-free on the per-edge hot path; record
  // allocation happens only when the accessor is called on pause.
  let lastMemReadAddr = -1;
  let lastMemReadValue = 0;
  let lastMemWriteAddr = -1;
  let lastMemWriteValue = 0;
  let lastIoReadAddr = -1;
  let lastIoReadValue = 0;
  let lastIoWriteAddr = -1;
  let lastIoWriteValue = 0;
  const resolve = () => {
    const { nM1, nMREQ, nIORQ, nRD, nWR, addr, data } = cpu.bus;
    if (nMREQ === 0) {
      if (nRD === 0) {
        const v = mem[addr];
        cpu.bus.data = v;
        lastMemReadAddr = addr;
        lastMemReadValue = v;
      }
      if (nWR === 0) {
        mem[addr] = data;
        lastMemWriteAddr = addr;
        lastMemWriteValue = data;
      }
    }
    if (nIORQ === 0) {
      // INT acknowledge: M1 + IORQ asserted together. Place the vector
      // byte; the CPU samples it during the IM1/IM2 fetch. NOT counted
      // as an IO read — the byte comes from intVector, not io[].
      if (nM1 === 0) {
        cpu.bus.data = intVector;
      } else {
        if (nRD === 0) {
          const v = io[addr];
          cpu.bus.data = v;
          lastIoReadAddr = addr;
          lastIoReadValue = v;
        }
        if (nWR === 0) {
          io[addr] = data;
          lastIoWriteAddr = addr;
          lastIoWriteValue = data;
        }
      }
    }
  };
  return {
    mem,
    io,
    resolve,
    intVector: () => intVector,
    setIntVector(byte) {
      intVector = byte & 0xff;
    },
    lastMemRead: () =>
      lastMemReadAddr < 0
        ? null
        : { addr: lastMemReadAddr, value: lastMemReadValue },
    lastMemWrite: () =>
      lastMemWriteAddr < 0
        ? null
        : { addr: lastMemWriteAddr, value: lastMemWriteValue },
    lastIoRead: () =>
      lastIoReadAddr < 0
        ? null
        : { addr: lastIoReadAddr, value: lastIoReadValue },
    lastIoWrite: () =>
      lastIoWriteAddr < 0
        ? null
        : { addr: lastIoWriteAddr, value: lastIoWriteValue },
  };
}
