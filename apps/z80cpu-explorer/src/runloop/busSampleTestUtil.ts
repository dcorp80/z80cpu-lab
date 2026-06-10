// Test-only helpers for the HW-trace buffer.
//
// Production records straight off the live CPU bus via
// `HwTraceBuffer.record(cpu.bus, nNMI, hcBox)` — no intermediate object,
// HC arrives via a Float64Array slot so the stamp never materializes a
// HeapNumber. Tests prefer to express a bus state as a normalized
// `BusSample` (deasserted defaults + `withOverrides`) and feed it
// through `recordSample`, which reverses the normalization into the raw
// `BusReadout` shape the buffer consumes and wraps `hc` into a one-shot
// box. Keeping this in a test util (not the hot path) is the whole
// point — `makeBusSample` was only ever load-bearing for tests.

import type { BusReadout, BusSample, HwTraceBuffer, Tri } from "./hwTrace.ts";

export type { BusSample } from "./hwTrace.ts";

/**
 * A fresh `BusSample` matching the Z80 CPU's reset defaults — all level
 * pins deasserted high, strobes high, addr=0, data=undefined. Tests layer
 * `withOverrides` on top to express a specific bus state.
 */
export function makeBusSample(): BusSample {
  return {
    nM1: 1,
    nRFSH: 1,
    nHALT: 1,
    nBUSACK: 1,
    nINT: 1,
    nNMI: 1,
    nRESET: 1,
    nBUSRQ: 1,
    nWAIT: 1,
    nMREQ: 1,
    nIORQ: 1,
    nRD: 1,
    nWR: 1,
    addr: 0,
    data: undefined,
  };
}

/** Reverse the recorder's strobe normalization: `Tri` 2 ("Z") → `undefined`. */
function unTri(v: Tri): 0 | 1 | undefined {
  return v === 2 ? undefined : v;
}

/**
 * Record a `BusSample` the way production records the raw bus: splits the
 * sample's `nNMI` out (the CPU bus surface has none — it's injected
 * separately, DESIGN §2.1) and de-normalizes tristate strobes back to
 * `undefined` so `record` re-normalizes them identically.
 */
export function recordSample(
  buf: HwTraceBuffer,
  s: BusSample,
  hc: number,
): void {
  const readout: BusReadout = {
    nM1: s.nM1,
    nRFSH: s.nRFSH,
    nHALT: s.nHALT,
    nBUSACK: s.nBUSACK,
    nMREQ: unTri(s.nMREQ),
    nIORQ: unTri(s.nIORQ),
    nRD: unTri(s.nRD),
    nWR: unTri(s.nWR),
    nINT: s.nINT,
    nRESET: s.nRESET,
    nBUSRQ: s.nBUSRQ,
    nWAIT: s.nWAIT,
    addr: s.addr,
    data: s.data,
  };
  const hcBox = new Float64Array(1);
  hcBox[0] = hc;
  buf.record(readout, s.nNMI, hcBox);
}
