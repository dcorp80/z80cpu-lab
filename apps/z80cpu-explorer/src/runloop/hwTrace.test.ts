import { describe, expect, it } from "vitest";
import {
  DEFAULT_HW_TRACE_CONFIG,
  type HwTraceConfig,
} from "../config/defaults.ts";
import { makeBusSample, recordSample } from "./busSampleTestUtil.ts";
import {
  type BusSample,
  type BusSnapshotRecord,
  HwTraceBuffer,
} from "./hwTrace.ts";

// Tiny config — a small power-of-two ring makes wrap/eviction visible
// without driving millions of edges per assertion.
function tinyConfig(overrides: Partial<HwTraceConfig> = {}): HwTraceConfig {
  return {
    enabled: true,
    capacity: 8,
    ...overrides,
  };
}

function withOverrides(s: BusSample, p: Partial<BusSample>): BusSample {
  return { ...s, ...p };
}

function collect(it: Iterable<BusSnapshotRecord>): BusSnapshotRecord[] {
  return Array.from(it);
}

describe("HwTraceBuffer — construction", () => {
  it("rejects non-positive or non-integer capacity", () => {
    expect(() => new HwTraceBuffer(tinyConfig({ capacity: 0 }))).toThrow(
      RangeError,
    );
    expect(() => new HwTraceBuffer(tinyConfig({ capacity: -1 }))).toThrow(
      RangeError,
    );
    expect(() => new HwTraceBuffer(tinyConfig({ capacity: 1.5 }))).toThrow(
      RangeError,
    );
  });

  it("rejects non-power-of-two capacity", () => {
    expect(() => new HwTraceBuffer(tinyConfig({ capacity: 6 }))).toThrow(
      RangeError,
    );
    expect(() => new HwTraceBuffer(tinyConfig({ capacity: 12 }))).toThrow(
      RangeError,
    );
  });

  it("default config is usable", () => {
    const buf = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);
    expect(buf.capacity()).toBe(DEFAULT_HW_TRACE_CONFIG.capacity);
    expect(buf.oldestHc()).toBeUndefined();
    expect(buf.newestHc()).toBeUndefined();
    expect(buf.size()).toBe(0);
  });
});

describe("HwTraceBuffer — record", () => {
  it("opens slot 0 on the first record", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const sample = makeBusSample();
    recordSample(buf, sample, 1);
    expect(buf.size()).toBe(1);
    expect(buf.oldestHc()).toBe(1);
    expect(buf.newestHc()).toBe(1);
  });

  it("does not advance head when nothing changed", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const sample = makeBusSample();
    recordSample(buf, sample, 1);
    recordSample(buf, sample, 2);
    recordSample(buf, sample, 3);
    expect(buf.size()).toBe(1);
    // newestHc reflects the only stored record, not the latest no-op call.
    expect(buf.newestHc()).toBe(1);
  });

  it("advances head when any signal changed", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const a = makeBusSample();
    const b = withOverrides(a, { nM1: 0 });
    const c = withOverrides(b, { nMREQ: 0 });
    recordSample(buf, a, 1);
    recordSample(buf, b, 2);
    recordSample(buf, c, 3);
    expect(buf.size()).toBe(3);
    expect(buf.newestHc()).toBe(3);
  });

  it("advances on data tristate↔value transitions", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const a = makeBusSample(); // data=undefined initially
    const b = withOverrides(a, { data: 0xa5 });
    const c = withOverrides(b, { data: undefined });
    recordSample(buf, a, 1);
    recordSample(buf, b, 2);
    recordSample(buf, c, 3);
    expect(buf.size()).toBe(3);
  });

  it("wraps the head past capacity without dropping records below cap", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 4 }));
    let prev = makeBusSample();
    recordSample(buf, prev, 1);
    for (let i = 2; i <= 4; i++) {
      prev = withOverrides(prev, { nM1: (i & 1) as 0 | 1 });
      recordSample(buf, prev, i);
    }
    // Exactly at capacity — nothing evicted yet.
    expect(buf.size()).toBe(4);
    expect(buf.oldestHc()).toBe(1);
    expect(buf.newestHc()).toBe(4);
  });

  it("evicts the oldest record when the ring overflows", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 8 }));
    // Write 12 distinct snapshots into a cap-8 ring — 4 oldest evicted.
    let prev = makeBusSample();
    for (let hc = 1; hc <= 12; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    expect(buf.size()).toBe(8);
    expect(buf.oldestHc()).toBe(5); // first 4 evicted one at a time
    expect(buf.newestHc()).toBe(12);
  });
});

describe("HwTraceBuffer — rangeView", () => {
  it("returns empty stream on a fresh buffer", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    expect(collect(buf.rangeView(0, 100))).toEqual([]);
  });

  it("yields snapshots in ascending HC order", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 8 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    const out = collect(buf.rangeView(0, 10));
    expect(out.map((s) => s.hc)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("filters to the [lo, hi] window", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 16 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 8; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    const out = collect(buf.rangeView(3, 5));
    expect(out.map((s) => s.hc)).toEqual([3, 4, 5]);
  });

  it("returns empty stream when window is reversed", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const a = makeBusSample();
    recordSample(buf, a, 5);
    expect(collect(buf.rangeView(10, 1))).toEqual([]);
  });

  it("walks correctly across the ring wrap point", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 4 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    // Ring=4, 6 distinct records → oldest two (HCs 1, 2) evicted.
    expect(buf.size()).toBe(4);
    const out = collect(buf.rangeView(0, 10));
    expect(out.map((s) => s.hc)).toEqual([3, 4, 5, 6]);
  });

  it("yielded snapshots preserve every field including tristate", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const a = withOverrides(makeBusSample(), {
      nM1: 0,
      nMREQ: 0,
      addr: 0x4042,
      data: 0xa5,
    });
    const b = withOverrides(a, { data: undefined });
    recordSample(buf, a, 1);
    recordSample(buf, b, 2);
    const out = collect(buf.rangeView(0, 10));
    expect(out[0].nM1).toBe(0);
    expect(out[0].nMREQ).toBe(0);
    expect(out[0].addr).toBe(0x4042);
    expect(out[0].data).toBe(0xa5);
    expect(out[1].data).toBeUndefined();
    expect(out[1].addr).toBe(0x4042); // unchanged but still in snapshot
  });
});

describe("HwTraceBuffer — latestBefore", () => {
  it("returns undefined on a fresh buffer", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    expect(buf.latestBefore(100)).toBeUndefined();
  });

  it("returns undefined when nothing is older than hc", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 16 }));
    recordSample(buf, makeBusSample(), 5);
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 0 }), 8);
    // First record is at HC=5; nothing strictly before HC=5.
    expect(buf.latestBefore(5)).toBeUndefined();
    expect(buf.latestBefore(1)).toBeUndefined();
  });

  it("returns the most recent full snapshot strictly before hc", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 16 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1, addr: hc });
      recordSample(buf, prev, hc);
    }
    // Before HC=4 ⇒ snapshot at HC=3 (addr=3, nM1=1).
    const s = buf.latestBefore(4);
    expect(s?.hc).toBe(3);
    expect(s?.addr).toBe(3);
    expect(s?.nM1).toBe(1);
    // hc past the newest ⇒ newest snapshot.
    expect(buf.latestBefore(100)?.hc).toBe(6);
  });

  it("finds the boundary snapshot across the ring wrap", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 4 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1, addr: hc });
      recordSample(buf, prev, hc);
    }
    // Cap=4 with 6 records → surviving HCs are 3,4,5,6 (head wrapped twice).
    const s = buf.latestBefore(5);
    expect(s?.hc).toBe(4);
    expect(s?.addr).toBe(4);
  });

  it("honors eviction — returns undefined when the seed aged out", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 2 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 5; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1, addr: hc });
      recordSample(buf, prev, hc);
    }
    // Cap=2, 5 records → only HCs 4, 5 survive. Nothing before HC=4 remains.
    expect(buf.latestBefore(4)).toBeUndefined();
    expect(buf.latestBefore(5)?.hc).toBe(4);
  });
});

describe("HwTraceBuffer — capture toggle", () => {
  it("enabled=false makes record a no-op", () => {
    const buf = new HwTraceBuffer(tinyConfig({ enabled: false }));
    const a = makeBusSample();
    recordSample(buf, a, 1);
    recordSample(buf, withOverrides(a, { nM1: 0 }), 2);
    expect(buf.size()).toBe(0);
    expect(collect(buf.rangeView(0, 10))).toEqual([]);
  });

  it("setEnabled toggles capture without rewriting existing history", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    recordSample(buf, makeBusSample(), 1);
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 0 }), 2);
    buf.setEnabled(false);
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 1 }), 3); // dropped
    buf.setEnabled(true);
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 0, nMREQ: 0 }), 4);
    const hcs = collect(buf.rangeView(0, 10)).map((s) => s.hc);
    expect(hcs).toEqual([1, 2, 4]);
  });

  it("setEnabled is a no-op when the value is unchanged", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const v0 = buf.version();
    buf.setEnabled(true);
    expect(buf.version()).toBe(v0);
    buf.setEnabled(false);
    expect(buf.version()).toBe(v0 + 1);
    buf.setEnabled(false);
    expect(buf.version()).toBe(v0 + 1);
  });
});

describe("HwTraceBuffer — version", () => {
  it("bumps on each mutating record but not on no-change", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const v0 = buf.version();
    const a = makeBusSample();
    recordSample(buf, a, 1);
    expect(buf.version()).toBe(v0 + 1);
    recordSample(buf, a, 2); // no-change
    expect(buf.version()).toBe(v0 + 1);
    recordSample(buf, withOverrides(a, { nM1: 0 }), 3);
    expect(buf.version()).toBe(v0 + 2);
  });

  it("bumps on clear", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    recordSample(buf, makeBusSample(), 1);
    const v0 = buf.version();
    buf.clear();
    expect(buf.version()).toBe(v0 + 1);
  });
});

describe("HwTraceBuffer — clear", () => {
  it("empties the ring; next record reopens slot 0", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    expect(buf.size()).toBeGreaterThan(0);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.oldestHc()).toBeUndefined();
    expect(buf.newestHc()).toBeUndefined();
    expect(collect(buf.rangeView(0, 10))).toEqual([]);
    // Recording resumes cleanly.
    recordSample(buf, makeBusSample(), 100);
    expect(buf.size()).toBe(1);
    expect(buf.oldestHc()).toBe(100);
  });
});

describe("HwTraceBuffer — long-run survival", () => {
  it("survives many wraps without ring accounting drift", () => {
    const buf = new HwTraceBuffer(tinyConfig({ capacity: 16 }));
    let prev = makeBusSample();
    for (let i = 0; i < 100; i++) {
      prev = withOverrides(prev, { nM1: (i & 1) as 0 | 1 });
      recordSample(buf, prev, i + 1);
    }
    // Ring caps at 16 records max; the newest record is always tracked.
    expect(buf.size()).toBe(16);
    expect(buf.newestHc()).toBe(100);
    expect(buf.oldestHc()).toBe(85); // 100 - 16 + 1
  });
});
