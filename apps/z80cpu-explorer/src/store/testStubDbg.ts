import type { CpuState } from "@dcorp80/z80cpu";
import { InstructionTrace } from "@dcorp80/z80cpu-debug";

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
  /** Live in-flight instruction — store reads on pause. Default empty
   *  (length=0 means "no instruction in flight" → snapshot is null). */
  readonly curr: InstructionTrace;
  /** Mirrors Z80DebugContext.enabled — store seeds this on cold boot and
   *  writes it when the Trace-instructions toggle flips. */
  enabled: boolean;
  /** Stage the in-flight instruction. `bytes` populates `curr.bytes[0..len]`
   *  and sets `length`. `nextPc` defaults to `startAddr` (mirroring the
   *  real dbg's `_initFreshCurr`, which seeds nextPc = M1 fetch addr
   *  until the next M1 T1_0 overwrites it). Pass an explicit `nextPc`
   *  to model the 2-HC transitional window between next M1 T1_0 and
   *  T3_0, where curr.nextPc has been updated but curr hasn't yet been
   *  promoted to prev. */
  setCurr: (patch: {
    startAddr?: number;
    bytes?: number[];
    m1Type?: InstructionTrace["m1Type"];
    nextPc?: number;
  }) => void;
}

// `state()` returns a fresh clone each call: the store stores the
// snapshot by reference and re-using the same object would suppress
// signal propagation (Solid signals compare by `===`).
export function makeStubDbg(): StubDbg {
  let next = freshCpuState();
  const curr = new InstructionTrace();
  return {
    state: () => ({ ...next, main: { ...next.main }, alt: { ...next.alt } }),
    setNext: (patch) => {
      next = { ...next, ...patch };
    },
    curr,
    enabled: true,
    setCurr: (patch) => {
      if (patch.startAddr !== undefined) {
        curr.startAddr = patch.startAddr;
        // Default nextPc to startAddr unless explicitly overridden in
        // this same call — matches `_initFreshCurr` in z80dbg.ts.
        if (patch.nextPc === undefined) curr.nextPc = patch.startAddr;
      }
      if (patch.nextPc !== undefined) curr.nextPc = patch.nextPc;
      if (patch.m1Type !== undefined) curr.m1Type = patch.m1Type;
      if (patch.bytes !== undefined) {
        for (let i = 0; i < 4; i++) curr.bytes[i] = patch.bytes[i] ?? 0;
        curr.length = patch.bytes.length;
      }
    },
  };
}
