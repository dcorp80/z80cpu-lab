import { describe, expect, it } from "vitest";
import {
  lastPageBase,
  nextPageBase,
  pageBase,
  pageBoundaryFlags,
  pageLastAddr,
  prevPageBase,
} from "./paging.ts";

const KB = 1024;

describe("paging — pageBase", () => {
  it("aligns to the page boundary at every supported page size", () => {
    expect(pageBase(0x4321, 16 * KB)).toBe(0x4000);
    expect(pageBase(0x4321, 8 * KB)).toBe(0x4000);
    expect(pageBase(0x4321, 4 * KB)).toBe(0x4000);
    expect(pageBase(0x4321, 1 * KB)).toBe(0x4000);
    // Address inside a non-zero high page.
    expect(pageBase(0xc123, 16 * KB)).toBe(0xc000);
    expect(pageBase(0xe5ff, 8 * KB)).toBe(0xe000);
    expect(pageBase(0xa800, 1 * KB)).toBe(0xa800);
  });

  it("masks input to 16 bits (defensive — caller may pass a wider int)", () => {
    expect(pageBase(0x14321, 16 * KB)).toBe(0x4000);
  });
});

describe("paging — lastPageBase", () => {
  it("is `0x10000 - pageSize` for every supported page size", () => {
    expect(lastPageBase(16 * KB)).toBe(0xc000);
    expect(lastPageBase(8 * KB)).toBe(0xe000);
    expect(lastPageBase(4 * KB)).toBe(0xf000);
    expect(lastPageBase(1 * KB)).toBe(0xfc00);
  });
});

describe("paging — prevPageBase / nextPageBase", () => {
  it("returns null at the boundary that wraps off the address space", () => {
    expect(prevPageBase(0x0000, 16 * KB)).toBeNull();
    expect(prevPageBase(0x3fff, 16 * KB)).toBeNull(); // still in page 0
    expect(nextPageBase(0xc000, 16 * KB)).toBeNull();
    expect(nextPageBase(0xffff, 16 * KB)).toBeNull(); // still in last page
  });

  it("steps by pageSize otherwise", () => {
    expect(prevPageBase(0x4321, 16 * KB)).toBe(0x0000);
    expect(prevPageBase(0xc000, 16 * KB)).toBe(0x8000);
    expect(nextPageBase(0x4321, 16 * KB)).toBe(0x8000);
    expect(nextPageBase(0x0000, 16 * KB)).toBe(0x4000);
    // Smaller pages — pageBase(0x4321, 1024) is 0x4000, so the
    // neighbors are one 0x400 stride away.
    expect(nextPageBase(0x4321, 1 * KB)).toBe(0x4400);
    expect(prevPageBase(0x4321, 1 * KB)).toBe(0x3c00);
  });
});

describe("paging — pageLastAddr", () => {
  it("is page base + pageSize - 1", () => {
    expect(pageLastAddr(0x0000, 16 * KB)).toBe(0x3fff);
    expect(pageLastAddr(0x4321, 16 * KB)).toBe(0x7fff);
    expect(pageLastAddr(0xc000, 16 * KB)).toBe(0xffff);
    expect(pageLastAddr(0xc123, 1 * KB)).toBe(0xc3ff);
  });
});

describe("paging — pageBoundaryFlags", () => {
  it("flags page 0 as atFirst, last page as atLast", () => {
    expect(pageBoundaryFlags(0x0000, 16 * KB)).toEqual({
      atFirst: true,
      atLast: false,
    });
    expect(pageBoundaryFlags(0x3fff, 16 * KB)).toEqual({
      atFirst: true,
      atLast: false,
    });
    expect(pageBoundaryFlags(0xc000, 16 * KB)).toEqual({
      atFirst: false,
      atLast: true,
    });
    expect(pageBoundaryFlags(0xffff, 16 * KB)).toEqual({
      atFirst: false,
      atLast: true,
    });
  });

  it("flags middle pages as neither", () => {
    expect(pageBoundaryFlags(0x4000, 16 * KB)).toEqual({
      atFirst: false,
      atLast: false,
    });
    expect(pageBoundaryFlags(0x8123, 16 * KB)).toEqual({
      atFirst: false,
      atLast: false,
    });
  });
});
