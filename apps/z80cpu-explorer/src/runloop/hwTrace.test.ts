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

// Tiny config — small ring + small chunks make boundary behavior visible
// without driving millions of edges per assertion.
function tinyConfig(overrides: Partial<HwTraceConfig> = {}): HwTraceConfig {
  return {
    mode: "ring",
    ringChunks: 2,
    chunkSize: 4,
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
  it("rejects non-positive or non-integer ringChunks", () => {
    expect(() => new HwTraceBuffer(tinyConfig({ ringChunks: 0 }))).toThrow(
      RangeError,
    );
    expect(() => new HwTraceBuffer(tinyConfig({ ringChunks: -1 }))).toThrow(
      RangeError,
    );
    expect(() => new HwTraceBuffer(tinyConfig({ ringChunks: 1.5 }))).toThrow(
      RangeError,
    );
  });

  it("rejects non-positive or non-integer chunkSize", () => {
    expect(() => new HwTraceBuffer(tinyConfig({ chunkSize: 0 }))).toThrow(
      RangeError,
    );
    expect(() => new HwTraceBuffer(tinyConfig({ chunkSize: -5 }))).toThrow(
      RangeError,
    );
  });

  it("default config is usable", () => {
    const buf = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);
    expect(buf.ringCapacity()).toBe(DEFAULT_HW_TRACE_CONFIG.ringChunks);
    expect(buf.chunkCapacity()).toBe(DEFAULT_HW_TRACE_CONFIG.chunkSize);
    expect(buf.oldestHc()).toBeUndefined();
    expect(buf.newestHc()).toBeUndefined();
    expect(buf.size()).toBe(0);
  });
});

describe("HwTraceBuffer — record", () => {
  it("opens the first chunk on the first record", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const sample = makeBusSample();
    recordSample(buf, sample, 1);
    expect(buf.size()).toBe(1);
    expect(buf.oldestHc()).toBe(1);
    expect(buf.newestHc()).toBe(1);
    expect(buf.recordedCount()).toBe(1);
  });

  it("does not advance pointer when nothing changed", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const sample = makeBusSample();
    recordSample(buf, sample, 1);
    recordSample(buf, sample, 2);
    recordSample(buf, sample, 3);
    expect(buf.recordedCount()).toBe(1);
    // newestHc reflects the only stored record, not the latest no-op call.
    expect(buf.newestHc()).toBe(1);
  });

  it("advances pointer when any signal changed", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const a = makeBusSample();
    const b = withOverrides(a, { nM1: 0 });
    const c = withOverrides(b, { nMREQ: 0 });
    recordSample(buf, a, 1);
    recordSample(buf, b, 2);
    recordSample(buf, c, 3);
    expect(buf.recordedCount()).toBe(3);
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
    expect(buf.recordedCount()).toBe(3);
  });

  it("rotates to a new chunk when chunkSize is exceeded", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 4 }));
    // 4 distinct snapshots fill chunk[0]; 5th forces rotation.
    let prev = makeBusSample();
    recordSample(buf, prev, 1);
    for (let i = 2; i <= 5; i++) {
      // Toggle nM1 on each step to guarantee a state change.
      prev = withOverrides(prev, { nM1: (i & 1) as 0 | 1 });
      recordSample(buf, prev, i);
    }
    expect(buf.size()).toBe(2);
    expect(buf.oldestHc()).toBe(1);
    expect(buf.newestHc()).toBe(5);
  });

  it("evicts the oldest chunk when the ring is full", () => {
    const buf = new HwTraceBuffer(tinyConfig({ ringChunks: 2, chunkSize: 4 }));
    // Fill 3 chunks worth — 4 + 4 + 4 distinct snapshots.
    let prev = makeBusSample();
    let hc = 0;
    for (let i = 0; i < 12; i++) {
      hc++;
      prev = withOverrides(prev, { nM1: (i & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    // Ring holds 2 chunks → only 8 of the 12 snapshots survive.
    expect(buf.size()).toBe(2);
    expect(buf.recordedCount()).toBe(8);
    expect(buf.oldestHc()).toBe(5); // first 4 evicted
  });
});

describe("HwTraceBuffer — rangeView", () => {
  it("returns empty stream on a fresh buffer", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    expect(collect(buf.rangeView(0, 100))).toEqual([]);
  });

  it("yields snapshots in ascending HC order", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 4 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    const out = collect(buf.rangeView(0, 10));
    expect(out.map((s) => s.hc)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("filters to the [lo, hi] window", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 8 }));
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

  it("walks across chunk boundaries", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 2 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 5; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    expect(buf.size()).toBe(2); // ring=2, chunkSize=2: 5 records → evicted to 4 in 2 chunks
    const out = collect(buf.rangeView(0, 10));
    // Two oldest chunks (HCs 1-2) get evicted by the 5th record's rotation;
    // surviving HCs are 3, 4, 5.
    expect(out.map((s) => s.hc)).toEqual([3, 4, 5]);
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
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 8 }));
    recordSample(buf, makeBusSample(), 5);
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 0 }), 8);
    // First record is at HC=5; nothing strictly before HC=5.
    expect(buf.latestBefore(5)).toBeUndefined();
    expect(buf.latestBefore(1)).toBeUndefined();
  });

  it("returns the most recent full snapshot strictly before hc", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 8 }));
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

  it("finds the boundary snapshot across chunk boundaries", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 2, ringChunks: 4 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1, addr: hc });
      recordSample(buf, prev, hc);
    }
    // HC 1-2 in chunk0, 3-4 in chunk1, 5-6 in chunk2. Before HC=5 ⇒ HC=4.
    const s = buf.latestBefore(5);
    expect(s?.hc).toBe(4);
    expect(s?.addr).toBe(4);
  });

  it("honors eviction — returns undefined when the seed aged out", () => {
    const buf = new HwTraceBuffer(tinyConfig({ chunkSize: 2, ringChunks: 2 }));
    let prev = makeBusSample();
    for (let hc = 1; hc <= 5; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1, addr: hc });
      recordSample(buf, prev, hc);
    }
    // Surviving HCs are 3, 4, 5 (1-2 evicted). Nothing before HC=3 remains.
    expect(buf.latestBefore(3)).toBeUndefined();
    expect(buf.latestBefore(5)?.hc).toBe(4);
  });
});

describe("HwTraceBuffer — modes", () => {
  it("mode='disabled' makes record a no-op", () => {
    const buf = new HwTraceBuffer(tinyConfig({ mode: "disabled" }));
    const a = makeBusSample();
    recordSample(buf, a, 1);
    recordSample(buf, withOverrides(a, { nM1: 0 }), 2);
    expect(buf.size()).toBe(0);
    expect(buf.recordedCount()).toBe(0);
    expect(collect(buf.rangeView(0, 10))).toEqual([]);
  });

  it("setMode toggles capture without rewriting existing history", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    recordSample(buf, makeBusSample(), 1);
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 0 }), 2);
    buf.setMode("disabled");
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 1 }), 3); // dropped
    buf.setMode("ring");
    recordSample(buf, withOverrides(makeBusSample(), { nM1: 0, nMREQ: 0 }), 4);
    const hcs = collect(buf.rangeView(0, 10)).map((s) => s.hc);
    expect(hcs).toEqual([1, 2, 4]);
  });

  it("setMode is a no-op when mode is unchanged", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    const v0 = buf.version();
    buf.setMode("ring");
    expect(buf.version()).toBe(v0);
    buf.setMode("disabled");
    expect(buf.version()).toBe(v0 + 1);
    buf.setMode("disabled");
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
  it("empties the ring; next record reopens chunk[0]", () => {
    const buf = new HwTraceBuffer(tinyConfig());
    let prev = makeBusSample();
    for (let hc = 1; hc <= 6; hc++) {
      prev = withOverrides(prev, { nM1: (hc & 1) as 0 | 1 });
      recordSample(buf, prev, hc);
    }
    expect(buf.size()).toBeGreaterThan(0);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.recordedCount()).toBe(0);
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
  it("survives many rotations without pool/ring accounting drift", () => {
    const buf = new HwTraceBuffer(tinyConfig({ ringChunks: 3, chunkSize: 4 }));
    let prev = makeBusSample();
    for (let i = 0; i < 100; i++) {
      prev = withOverrides(prev, { nM1: (i & 1) as 0 | 1 });
      recordSample(buf, prev, i + 1);
    }
    // Ring caps at 3 chunks × 4 records = 12 records max.
    expect(buf.size()).toBe(3);
    expect(buf.recordedCount()).toBeLessThanOrEqual(12);
    expect(buf.newestHc()).toBe(100);
  });
});
