import type { CpuState } from "@dcorp80/z80cpu";

// Minimal post-reset CpuState. Tests overwrite individual fields via
// `setNext`; structure matches the real `Z80DebugContext.state()` shape
// so type assignability holds at the createAppStore call site.
export function freshCpuState(): CpuState {
  return {
    pc: 0,
    sp: 0,
    ix: 0,
    iy: 0,
    i: 0,
    r: 0,
    wz: 0,
    main: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, f: 0 },
    alt: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, f: 0 },
    im: 0,
    imUndocumented: false,
    iff1: false,
    iff2: false,
    nmiPending: false,
  };
}

export interface StubDbg {
  state: () => CpuState;
  /** Stage the next `state()` return. Stays sticky across calls. */
  setNext: (patch: Partial<CpuState>) => void;
}

// `state()` returns a fresh clone each call: the store stores the
// snapshot by reference and re-using the same object would suppress
// signal propagation (Solid signals compare by `===`).
export function makeStubDbg(): StubDbg {
  let next = freshCpuState();
  return {
    state: () => ({ ...next, main: { ...next.main }, alt: { ...next.alt } }),
    setNext: (patch) => {
      next = { ...next, ...patch };
    },
  };
}
