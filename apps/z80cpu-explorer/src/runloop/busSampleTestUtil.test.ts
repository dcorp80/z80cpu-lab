import { describe, expect, it } from "vitest";
import { DEFAULT_HW_TRACE_CONFIG } from "../config/defaults.ts";
import { makeBusSample, recordSample } from "./busSampleTestUtil.ts";
import { HwTraceBuffer } from "./hwTrace.ts";

describe("makeBusSample", () => {
  it("matches the Z80 Bus reset defaults (deasserted highs, addr=0, data=undefined)", () => {
    const s = makeBusSample();
    expect(s.nM1).toBe(1);
    expect(s.nMREQ).toBe(1);
    expect(s.nRD).toBe(1);
    expect(s.nNMI).toBe(1);
    expect(s.addr).toBe(0);
    expect(s.data).toBeUndefined();
  });
});

describe("recordSample", () => {
  it("de-normalizes tristate strobes and splits nNMI through to the buffer", () => {
    const buf = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);
    // Strobe in tristate (Tri 2), data floating, nNMI asserted low.
    recordSample(
      buf,
      { ...makeBusSample(), nMREQ: 2, data: undefined, nNMI: 0 },
      1,
    );
    const [snap] = Array.from(buf.rangeView(0, 10));
    expect(snap.hc).toBe(1);
    expect(snap.nMREQ).toBe(2); // round-trips: Tri 2 → undefined → Tri 2
    expect(snap.data).toBeUndefined();
    expect(snap.nNMI).toBe(0);
  });

  it("passes through numeric strobe + bus values unchanged", () => {
    const buf = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);
    recordSample(
      buf,
      { ...makeBusSample(), nMREQ: 0, addr: 0x4042, data: 0xa5 },
      2,
    );
    const [snap] = Array.from(buf.rangeView(0, 10));
    expect(snap.nMREQ).toBe(0);
    expect(snap.addr).toBe(0x4042);
    expect(snap.data).toBe(0xa5);
  });
});
