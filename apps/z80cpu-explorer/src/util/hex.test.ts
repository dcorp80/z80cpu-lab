import { describe, expect, it } from "vitest";
import { formatHex, parseHex } from "./hex.ts";

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
});
