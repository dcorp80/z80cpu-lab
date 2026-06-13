import { describe, expect, it } from "vitest";
import { filterHexInput, formatHex, parseAddr16, parseHex } from "./hex.ts";

describe("formatHex", () => {
  it("renders bare uppercase hex", () => {
    expect(formatHex(0x8000)).toBe("8000");
    expect(formatHex(0xab)).toBe("AB");
    expect(formatHex(0)).toBe("0");
  });

  it("pads to width", () => {
    expect(formatHex(0x42, 4)).toBe("0042");
    expect(formatHex(0xabcde, 4)).toBe("ABCDE");
  });
});

describe("parseHex", () => {
  it("accepts bare hex", () => {
    expect(parseHex("8000")).toBe(0x8000);
    expect(parseHex("ff")).toBe(0xff);
    expect(parseHex("FF")).toBe(0xff);
  });

  it("accepts $-prefix", () => {
    expect(parseHex("$8000")).toBe(0x8000);
  });

  it("accepts 0x-prefix", () => {
    expect(parseHex("0x8000")).toBe(0x8000);
    expect(parseHex("0X8000")).toBe(0x8000);
  });

  it("accepts h-suffix", () => {
    expect(parseHex("8000h")).toBe(0x8000);
    expect(parseHex("ABh")).toBe(0xab);
  });

  it("trims whitespace", () => {
    expect(parseHex("  8000  ")).toBe(0x8000);
  });

  it("rejects garbage", () => {
    expect(parseHex("xyz")).toBeNull();
    expect(parseHex("")).toBeNull();
    expect(parseHex("80 00")).toBeNull();
    expect(parseHex("$$8000")).toBeNull();
  });

  it("rejects mixed prefix+suffix forms", () => {
    expect(parseHex("$FFh")).toBeNull();
    expect(parseHex("0xFFh")).toBeNull();
  });
});

describe("filterHexInput", () => {
  it("strips characters that can't appear in any hex notation", () => {
    expect(filterHexInput("ff00")).toBe("ff00");
    expect(filterHexInput("$8000")).toBe("$8000");
    expect(filterHexInput("0xABCD")).toBe("0xABCD");
    expect(filterHexInput("FFh")).toBe("FFh");
    // 'e' and 'd' are hex digits; 'h' survives as a possible suffix.
    expect(filterHexInput("hello world 0x4000!")).toBe("hed0x4000");
    expect(filterHexInput("  ff 00  ")).toBe("ff00");
    expect(filterHexInput("g1!@#z")).toBe("1");
  });
});

describe("parseAddr16", () => {
  it("accepts values in 0..FFFF", () => {
    expect(parseAddr16("0")).toBe(0);
    expect(parseAddr16("ffff")).toBe(0xffff);
    expect(parseAddr16("$8000")).toBe(0x8000);
  });

  it("rejects values above FFFF", () => {
    expect(parseAddr16("10000")).toBeNull();
    expect(parseAddr16("$FFFFF")).toBeNull();
  });

  it("rejects invalid hex", () => {
    expect(parseAddr16("xyz")).toBeNull();
    expect(parseAddr16("")).toBeNull();
  });
});
