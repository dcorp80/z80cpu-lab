// Pure helpers for the Memory / IO section page-navigation model.
// The 16-bit
// address space is divided into pages of `pageSize` bytes; navigation
// snaps the watch address to a page boundary. All math wraps `& 0xFFFF`
// so callers don't have to.

/** 64K address space. Memory + IO both use it (IO's 8-bit view runs
 *  in 256-port space and hides the page-nav row entirely). */
export const ADDR_SPACE = 0x10000;

/** Mask `addr` down to the start of its page. Page sizes are powers of
 *  two so `~(size - 1)` is the alignment mask. */
export function pageBase(addr: number, pageSize: number): number {
  return addr & 0xffff & ~(pageSize - 1);
}

/** Last page's base address (e.g. `C000` at 16 KB, `E000` at 8 KB). */
export function lastPageBase(pageSize: number): number {
  return (ADDR_SPACE - pageSize) & 0xffff;
}

/** Previous page's base, or `null` if the current page is already 0. */
export function prevPageBase(addr: number, pageSize: number): number | null {
  const base = pageBase(addr, pageSize);
  if (base === 0) return null;
  return (base - pageSize) & 0xffff;
}

/** Next page's base, or `null` if the current page is already last. */
export function nextPageBase(addr: number, pageSize: number): number | null {
  const base = pageBase(addr, pageSize);
  const last = lastPageBase(pageSize);
  if (base === last) return null;
  return (base + pageSize) & 0xffff;
}

/** Address (inclusive) of the last byte in `addr`'s page. */
export function pageLastAddr(addr: number, pageSize: number): number {
  return (pageBase(addr, pageSize) + pageSize - 1) & 0xffff;
}

export interface PageBoundaryFlags {
  /** `<<` disabled — already at page 0. */
  atFirst: boolean;
  /** `>>` disabled — already at the last page. */
  atLast: boolean;
}

export function pageBoundaryFlags(
  addr: number,
  pageSize: number,
): PageBoundaryFlags {
  const base = pageBase(addr, pageSize);
  return { atFirst: base === 0, atLast: base === lastPageBase(pageSize) };
}
