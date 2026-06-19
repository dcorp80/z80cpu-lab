// 64K mem + (one or two) 64K IO planes bus resolver with INT-ack
// injection: on memory read/write
// resolve against mem[]; on IO read/write resolve against ioRead[] /
// ioWrite[] per split mode; on INT acknowledge (`nM1` low + `nIORQ`
// low) place the configured INT vector byte on `cpu.bus.data`.
//
// IO split mode: when `splitIo` is true, IN cycles read from
// `ioRead` (user-editable, pre-loaded) and OUT cycles land in `ioWrite`
// (passive record, never user-edited). When false, both directions
// target `ioRead` — the original single-plane behavior. Allocation is
// lazy: `ioWrite` is null when `splitIo` is false, so the joined
// configuration costs 64 KB rather than 128 KB. The flag is fixed at
// construction; toggling it routes through reinit (page reload).
//
// Input pins (M8b): the bus owns the authoritative pin state. Level pins
// (`nINT`/`nRESET`/`nBUSRQ`/`nWAIT`) and `nNMI` are written via
// `setInputPin`; `resolve()` (preEdge) applies them to `cpu.bus` and, for
// `nNMI`, fires `cpu.nmi()` on the 1→0 transition (edge-triggered on the
// CPU side). Holding `nNMI` low across many edges fires once, not once-
// per-service. boot.tsx's postEdge auto-clears `nNMI` back to 1 after
// recording so the checkbox UX is momentary ([[feedback-nmi-pulse-
// semantics]]), but that wrapper is now a UX detail rather than a
// correctness requirement — the bus is intrinsically safe on its own.

import type { Z80Cpu } from "@dcorp80/z80cpu";
import type { BusConfig } from "../config/defaults.ts";

/** Input-pin signal names this bus exposes. Lives alongside the
 *  `getInputPin`/`setInputPin` API so callers stay in lockstep with the
 *  bus's understanding of which pins are user-controllable. */
export const INPUT_PIN_NAMES = [
  "nINT",
  "nNMI",
  "nRESET",
  "nBUSRQ",
  "nWAIT",
] as const;
export type InputPinName = (typeof INPUT_PIN_NAMES)[number];

export const MEM_SIZE = 0x10000;
export const IO_SIZE = 0x10000;

/**
 * Snapshot of the most recent mem/IO read or write the bus resolved.
 * Used by the Memory and IO sections' folded summaries
 * — the store samples these on `loop.onPause`, so they always reflect
 * what the CPU did before pausing, not stale per-edge churn during run.
 */
export interface BusAccessRecord {
  addr: number;
  value: number;
}

export interface Bus64k {
  mem: Uint8Array;
  /**
   * Plane services CPU IN cycles. In joined mode (`splitIo === false`)
   * also receives CPU OUT cycles — i.e. the canonical IO array in the
   * unsplit configuration. Always allocated.
   */
  ioRead: Uint8Array;
  /**
   * Plane services CPU OUT cycles in split mode. `null` in joined mode
   * — checked by `resolve()` and `splitIo`-aware consumers. Never edited
   * by the user (the IO section renders it read-only).
   */
  ioWrite: Uint8Array | null;
  /** Fixed at construction; mirrors `BusConfig.splitIo`. */
  splitIo: boolean;
  /**
   * Fill byte applied to every mem cell at construction; mirrors
   * `BusConfig.memInit`. Exposed so the App-shell can show the live
   * value next to its pending-edit input, with the same fallback
   * pattern as `splitIo`.
   */
  memInit: number;
  /** Fill byte applied to every IO cell at construction; mirrors `BusConfig.ioInit`. */
  ioInit: number;
  /**
   * Write `value` into all 256 high-byte aliases of `port` in `ioRead`
   * (`ioRead[(hi<<8) | port] = value` for hi in 0..255). Used by the
   * IO section's 8-bit view so the user can seed an
   * A0–A7-only-decoded port without minding the upper address bits.
   * Always targets the RD plane — the WR plane is not user-editable.
   * Inputs are masked at the boundary; caller bumps the version signal.
   */
  broadcastIoLowByte(port: number, value: number): void;
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
  /**
   * Read the current level of a CPU input pin (M8b). All five
   * pins default to deasserted (1, active-low). `nNMI` is held as a
   * level here but translated to an edge on the way to the CPU —
   * `resolve()` calls `cpu.nmi()` once on the 1→0 transition, so
   * leaving `nNMI` low across edges fires exactly once. The user-visible
   * 1-HC-pulse appearance comes from boot.tsx's postEdge auto-clear
   * ([[feedback-nmi-pulse-semantics]]).
   */
  getInputPin(name: InputPinName): 0 | 1;
  /** Update an input-pin level. Value is masked to 0|1 at the boundary. */
  setInputPin(name: InputPinName, value: 0 | 1): void;
  /** Byte placed on `cpu.bus.data` during INT-acknowledge cycles. */
  intVector(): number;
  /** Updates the INT vector. Value is masked to 8 bits at the boundary. */
  setIntVector(byte: number): void;
}

export function makeBus64k(cpu: Z80Cpu, config: BusConfig): Bus64k {
  // Init bytes masked at the bus boundary (per validation-boundary rule —
  // a config value from a user-facing surface mustn't trust upstream masking).
  const memInit = config.memInit & 0xff;
  const ioInit = config.ioInit & 0xff;
  const splitIo = config.splitIo === true;
  const mem = new Uint8Array(MEM_SIZE).fill(memInit);
  const ioRead = new Uint8Array(IO_SIZE).fill(ioInit);
  // Lazy: 64 KB of WR-plane backing store only exists when split is on.
  const ioWrite = splitIo ? new Uint8Array(IO_SIZE).fill(ioInit) : null;
  // INT vector storage is owned by the bus, just like the IO planes.
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

  // Input-pin levels. Bus owns them authoritatively; resolve() applies
  // them to cpu.bus on every preEdge. All deasserted (1) at construction.
  const inputPins: Record<InputPinName, 0 | 1> = {
    nINT: 1,
    nNMI: 1,
    nRESET: 1,
    nBUSRQ: 1,
    nWAIT: 1,
  };
  // Previous-edge nNMI level for edge-detection. The CPU's nmi() is
  // edge-triggered; firing it every edge while held low would re-arm
  // nmiFf after each service completes (nmiAck clears between services)
  // and peg the CPU in an NMI loop. We translate the UI's level pin to
  // an edge here so the bus is intrinsically safe regardless of whether
  // an external pulse-clear (boot.tsx postEdge) is wired up.
  let prevNmiLevel: 0 | 1 = 1;

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
      // as an IO read — the byte comes from intVector, not ioRead.
      if (nM1 === 0) {
        cpu.bus.data = intVector;
      } else {
        if (nRD === 0) {
          // IN always reads the RD plane (joined or split — RD is the
          // user-facing readable plane in both modes).
          const v = ioRead[addr];
          cpu.bus.data = v;
          lastIoReadAddr = addr;
          lastIoReadValue = v;
        }
        if (nWR === 0) {
          // OUT lands in WR in split mode, otherwise back into RD (the
          // joined single-plane). `ioWrite` is non-null exactly when
          // `splitIo` is true; the null check on the same boolean is
          // what TS narrowing needs to type-check the array access.
          if (splitIo && ioWrite) {
            ioWrite[addr] = data;
          } else {
            ioRead[addr] = data;
          }
          lastIoWriteAddr = addr;
          lastIoWriteValue = data;
        }
      }
    }
    // Apply input pins. cpu.bus only carries level pins (nINT/nRESET/
    // nBUSRQ/nWAIT); nNMI is edge-triggered on the CPU side so we fire
    // cpu.nmi() exactly on the 1→0 transition. Holding nNMI low across
    // many edges fires the CPU once, not once-per-service.
    cpu.bus.nINT = inputPins.nINT;
    cpu.bus.nRESET = inputPins.nRESET;
    cpu.bus.nBUSRQ = inputPins.nBUSRQ;
    cpu.bus.nWAIT = inputPins.nWAIT;
    if (inputPins.nNMI === 0 && prevNmiLevel === 1) cpu.nmi();
    prevNmiLevel = inputPins.nNMI;
  };
  return {
    mem,
    ioRead,
    ioWrite,
    splitIo,
    memInit,
    ioInit,
    resolve,
    broadcastIoLowByte(port, value) {
      const p = port & 0xff;
      const v = value & 0xff;
      for (let hi = 0; hi < 256; hi++) {
        ioRead[(hi << 8) | p] = v;
      }
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
    intVector: () => intVector,
    setIntVector(byte) {
      intVector = byte & 0xff;
    },
    getInputPin: (name) => inputPins[name],
    setInputPin(name, value) {
      // Mask to 0|1 at the boundary — validation-boundary rule for
      // user-supplied values [[feedback_validation_boundary]].
      inputPins[name] = (value & 1) as 0 | 1;
    },
  };
}
