import { describe, expect, it } from "vitest";
import {
  type HwTraceGlyphs,
  renderBitRow,
  renderBusValueRow,
  renderTriRow,
} from "./render.ts";

// Use ASCII stand-ins in tests so glyph identity is obvious in failure
// output. The real STR.hwTrace.glyphs are pinned per the user feedback
// memo; rendering correctness is independent of the actual codepoints.
const G: HwTraceGlyphs = {
  high: "H",
  low: "L",
  tristate: "Z",
  busHoldFiller: ".",
};

describe("renderBitRow", () => {
  it("renders an empty window as empty string", () => {
    expect(renderBitRow([], 10, 9, 1, G)).toBe("");
  });

  it("renders a constant-high row when no transitions land in the window", () => {
    expect(renderBitRow([], 0, 4, 1, G)).toBe("HHHHH");
  });

  it("renders a constant-low row when initial value is low and no transitions", () => {
    expect(renderBitRow([], 0, 4, 0, G)).toBe("LLLLL");
  });

  it("drops to low at the transition HC and carries forward", () => {
    // Initial high; falls at hc=2, stays low.
    expect(renderBitRow([{ hc: 2, value: 0 }], 0, 5, 1, G)).toBe("HHLLLL");
  });

  it("renders multiple transitions in HC order", () => {
    expect(
      renderBitRow(
        [
          { hc: 1, value: 0 },
          { hc: 3, value: 1 },
          { hc: 5, value: 0 },
        ],
        0,
        6,
        1,
        G,
      ),
    ).toBe("HLLHHLL");
  });

  it("applies pre-window transitions to the carried value at windowLo", () => {
    // The renderer's contract: transitions with hc < windowLo set the
    // carry-forward value as if `cur` advanced through them. So a
    // transition at hc=5 with value=0 before a windowLo=10 leaves cur=0
    // at windowLo.
    expect(renderBitRow([{ hc: 5, value: 0 }], 10, 12, 1, G)).toBe("LLL");
  });

  it("transitions exactly at windowHi are honored", () => {
    expect(renderBitRow([{ hc: 4, value: 0 }], 0, 4, 1, G)).toBe("HHHHL");
  });
});

describe("renderTriRow", () => {
  it("renders Z for tristate", () => {
    expect(renderTriRow([{ hc: 2, value: 2 }], 0, 4, 1, G)).toBe("HHZZZ");
  });

  it("handles Z → 0 → 1 transitions", () => {
    expect(
      renderTriRow(
        [
          { hc: 0, value: 2 },
          { hc: 2, value: 0 },
          { hc: 4, value: 1 },
        ],
        0,
        5,
        1,
        G,
      ),
    ).toBe("ZZLLHH");
  });

  it("renders constant tristate when initial value is Z and no transitions", () => {
    expect(renderTriRow([], 0, 3, 2, G)).toBe("ZZZZ");
  });
});

describe("renderBusValueRow — addr (width=4)", () => {
  it("paints the hex value at the change site and fills with dots", () => {
    // 0x4042 at hc=2 in a 10-cell window starting at 0.
    expect(
      renderBusValueRow([{ hc: 2, value: 0x4042 }], 0, 9, 4, undefined, G),
      // First two cells: pre-transition (initial undefined → tristate filler).
      // hc=2..5: '4', '0', '4', '2'. hc=6..9: '.' filler.
    ).toBe("ZZ4042....");
  });

  it("uses bus-hold filler when initial value is a number (no transition yet)", () => {
    expect(
      renderBusValueRow([], 0, 4, 4, 0x4000, G),
      // Initial 0x4000 but no transition in window → all filler.
    ).toBe(".....");
  });

  it("truncates a value when the next transition arrives before width elapses", () => {
    // 0x1234 at hc=10 (would paint 1234 at cells 0..3), then 0xABCD
    // at hc=12 — overwrites cells 2,3,4,5 with A,B,C,D. Trailing
    // chars of 0x1234 ('3', '4') never render.
    expect(
      renderBusValueRow(
        [
          { hc: 10, value: 0x1234 },
          { hc: 12, value: 0xabcd },
        ],
        10,
        19,
        4,
        undefined,
        G,
      ),
    ).toBe("12ABCD....");
  });

  it("renders tristate (undefined) as ┈ chars in the value region and as filler", () => {
    expect(
      renderBusValueRow([{ hc: 2, value: undefined }], 0, 9, 4, 0x4000, G),
      // hc=0,1: hold filler from initial 0x4000.
      // hc=2..5: 4 tristate glyphs (value region).
      // hc=6..9: tristate filler (held tristate).
    ).toBe("..ZZZZZZZZ");
  });

  it("number → undefined → number alternation", () => {
    expect(
      renderBusValueRow(
        [
          { hc: 0, value: 0x4000 },
          { hc: 4, value: undefined },
          { hc: 8, value: 0x4001 },
        ],
        0,
        11,
        4,
        undefined,
        G,
      ),
    ).toBe("4000ZZZZ4001");
  });
});

describe("renderBusValueRow — data (width=2)", () => {
  it("paints a 2-char value at the change site", () => {
    expect(
      renderBusValueRow([{ hc: 1, value: 0xa5 }], 0, 4, 2, undefined, G),
    ).toBe("ZA5..");
  });

  it("packs back-to-back data transitions without filler between them", () => {
    expect(
      renderBusValueRow(
        [
          { hc: 0, value: 0x3e },
          { hc: 2, value: 0xa5 },
          { hc: 4, value: 0xff },
        ],
        0,
        5,
        2,
        undefined,
        G,
      ),
    ).toBe("3EA5FF");
  });
});

describe("renderBusValueRow — edge cases", () => {
  it("returns empty string when windowHi < windowLo", () => {
    expect(
      renderBusValueRow([{ hc: 0, value: 0 }], 5, 3, 4, undefined, G),
    ).toBe("");
  });

  it("ignores transitions that land entirely outside the window", () => {
    expect(
      renderBusValueRow(
        [
          { hc: 100, value: 0x4000 }, // way past window
        ],
        0,
        4,
        4,
        undefined,
        G,
      ),
    ).toBe("ZZZZZ");
  });
});
