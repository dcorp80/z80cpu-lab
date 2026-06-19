// HW-trace ring buffer — per-snapshot model.
//
// One flat ring of `capacity` snapshots; no internal chunk segmentation.
// `capacity` is required to be a power of two so the hot-path advance
// wraps with `& mask` instead of a runtime modulo. The recorder
// (boot.tsx's postEdge wrapper) calls `record(cpu.bus, nNMI, hc)` once
// per loop edge — reading the live bus directly, no intermediate copy:
//
//   - First record → snapshot stored at slot 0; head=tail=0, size=1.
//   - No-change record → no advance, no write.
//   - State-change record → head advances by one (mask-wrapped); when
//     the ring is full the oldest snapshot is evicted by advancing tail.
//
// Physical layout: four parallel TypedArrays indexed by ring slot.
//   - `_hcs` (Float64Array) — HC stamp (exact integers up to 2^53).
//   - `_state` (Uint32Array) — every 1-bit and tri-bit signal AND the
//     addr/data tristate flags packed into a single integer (layout
//     inlined in `record()` below). One compare per record replaces
//     fifteen TypedArray reads on the hot path.
//   - `_addr` (Uint16Array), `_data` (Uint8Array) — bus values. During a
//     bus grant the value is `undefined`; the corresponding slot is left
//     stale and the tristate flag in `_state` selects between "use slot"
//     and "report undefined" on read.
//
// Hot path is one `_state[head]` compare and (on change) four TypedArray
// writes — no chunk-object dereference, no per-call modulo, no branch
// for chunk rotation. Records are logically HC-ascending when walked
// `[tail, tail+1, …, tail+size-1] & mask`; physical contiguity is broken
// only by the single wrap point between `head` and `tail` once the ring
// has filled at least once.
//
// HC=0 is never recorded — the very first `record(curr, hc)` call comes
// from the loop AFTER its first clockEdge with hc ≥ 1.

import type { HwTraceConfig } from "../config/defaults.ts";
import { INPUT_PIN_NAMES, type InputPinName } from "./bus.ts";
import type { ReadonlyHcBox } from "./loop.ts";

// ── Signal taxonomy ──────────────────────────────────────────────

export type Tri = 0 | 1 | 2; // L | H | Z

/** CPU output pins always defined (no tristate). */
export const OUTPUT_BIT_SIGNALS = ["nM1", "nRFSH", "nHALT", "nBUSACK"] as const;

/** CPU output pins that tristate during bus grant. */
export const OUTPUT_TRI_SIGNALS = ["nMREQ", "nIORQ", "nRD", "nWR"] as const;

/** CPU input pins (always 0|1 on the sample side; the bus surface only
 *  exposes nINT/nRESET/nBUSRQ/nWAIT — nNMI is sampled from the bus's
 *  authoritative pin state). Aliased to `INPUT_PIN_NAMES`
 *  so the trace's signal list and the bus's user-controllable pin set
 *  stay one definition; if a new input pin lands on the bus it auto-
 *  appears in the trace's canonical order without touching this file. */
export const INPUT_BIT_SIGNALS = INPUT_PIN_NAMES;

/** Multi-bit bus values; undefined ⇒ tristate during a bus grant. */
export const BUS_VALUE_SIGNALS = ["addr", "data"] as const;

export type OutputBitSignal = (typeof OUTPUT_BIT_SIGNALS)[number];
export type OutputTriSignal = (typeof OUTPUT_TRI_SIGNALS)[number];
export type InputBitSignal = InputPinName;
export type BusValueSignal = (typeof BUS_VALUE_SIGNALS)[number];

export type BitSignal = OutputBitSignal | InputBitSignal;
export type TriSignal = OutputTriSignal;
export type SignalName = BitSignal | TriSignal | BusValueSignal;

/** Canonical order — defines column order for rendering and VCD export. */
export const ALL_SIGNALS: readonly SignalName[] = [
  ...OUTPUT_BIT_SIGNALS,
  ...OUTPUT_TRI_SIGNALS,
  ...INPUT_BIT_SIGNALS,
  ...BUS_VALUE_SIGNALS,
];

// ── Interchange shape (cold path) ────────────────────────────────

/**
 * One bus snapshot: full state of every signal at a given HC. Produced
 * by `rangeView` for the renderer and (in M8c) the VCD writer. The hot
 * `record()` path never builds these — it reads/writes the ring's
 * TypedArrays directly.
 */
export interface BusSnapshotRecord {
  hc: number;
  nM1: 0 | 1;
  nRFSH: 0 | 1;
  nHALT: 0 | 1;
  nBUSACK: 0 | 1;
  nMREQ: Tri;
  nIORQ: Tri;
  nRD: Tri;
  nWR: Tri;
  nINT: 0 | 1;
  nNMI: 0 | 1;
  nRESET: 0 | 1;
  nBUSRQ: 0 | 1;
  nWAIT: 0 | 1;
  addr: number | undefined;
  data: number | undefined;
}

/**
 * Full bus state minus the HC stamp, strobes already tristate-normalized
 * to `Tri`. The hot path no longer materializes one of these — `record`
 * reads the raw `BusReadout` straight off `cpu.bus`. Retained as the shape
 * tests build (`makeBusSample` + `withOverrides`) and feed through the
 * `recordSample` helper, and as the natural sibling of `BusSnapshotRecord`.
 */
export type BusSample = Omit<BusSnapshotRecord, "hc">;

/**
 * The slice of the CPU bus surface the recorder reads each edge. `cpu.bus`
 * satisfies this structurally, so production records straight off it with
 * zero intermediate copy. Strobes are `0 | 1 | undefined` here (the CPU's
 * native tristate encoding); `record` normalizes `undefined → Tri 2`.
 * `nNMI` is intentionally absent — it isn't on the CPU bus surface and is
 * injected as a separate `record` argument.
 */
export interface BusReadout {
  nM1: 0 | 1;
  nRFSH: 0 | 1;
  nHALT: 0 | 1;
  nBUSACK: 0 | 1;
  nMREQ: 0 | 1 | undefined;
  nIORQ: 0 | 1 | undefined;
  nRD: 0 | 1 | undefined;
  nWR: 0 | 1 | undefined;
  nINT: 0 | 1;
  nRESET: 0 | 1;
  nBUSRQ: 0 | 1;
  nWAIT: 0 | 1;
  addr: number | undefined;
  data: number | undefined;
}

// ── Packed bus state ─────────────────────────────────────────────
//
// The 13 single/tri-bit signals plus the addr/data tristate flags are
// packed into one integer per position. The hot path does ONE compare
// per record (`state[pos] !== packed`) instead of fifteen TypedArray
// reads, which is where the bulk of the recorder's speedup comes from.
//
// `nMREQ|nIORQ|nRD|nWR` arrive as `0|1|undefined` (the CPU's tristate
// encoding) and occupy 2 bits each (`undefined → 2`). The other nine
// signals are 1-bit (0|1). Two more 1-bit fields encode whether
// addr/data are currently tristated (1 = tristate, 0 = driven). Total
// = 4 + 4·2 + 5·1 + 2 = 19 bits, well within the V8 SMI range, so each
// `state[pos]` stays a tagged int.
//
// Bit layout, MSB→LSB:
//   nM1 | nRFSH | nHALT | nBUSACK | nMREQ(2) | nIORQ(2) | nRD(2) | nWR(2) |
//   nINT | nNMI | nRESET | nBUSRQ | nWAIT | addrTri | dataTri
//
// Packing, equality check, and writeback all live inline in `record()`
// — no helper functions. The per-edge path runs at ~40M Hz; flattening
// to one body lets V8 see the full sequence and avoid three call-site
// boundaries on every edge. `readSnapshot` (cold path, used by
// `rangeView` / `latestBefore`) keeps its own inline-inverse for clarity.

function readSnapshot(
  hcs: Float64Array,
  state: Uint32Array,
  addrArr: Uint16Array,
  dataArr: Uint8Array,
  idx: number,
): BusSnapshotRecord {
  // Unpack in reverse of the packing in `record()` — LSB first.
  let st = state[idx];
  const dataTri = (st & 1) as 0 | 1;
  st >>>= 1;
  const addrTri = (st & 1) as 0 | 1;
  st >>>= 1;
  const nWAIT = (st & 1) as 0 | 1;
  st >>>= 1;
  const nBUSRQ = (st & 1) as 0 | 1;
  st >>>= 1;
  const nRESET = (st & 1) as 0 | 1;
  st >>>= 1;
  const nNMI = (st & 1) as 0 | 1;
  st >>>= 1;
  const nINT = (st & 1) as 0 | 1;
  st >>>= 1;
  const nWR = (st & 3) as Tri;
  st >>>= 2;
  const nRD = (st & 3) as Tri;
  st >>>= 2;
  const nIORQ = (st & 3) as Tri;
  st >>>= 2;
  const nMREQ = (st & 3) as Tri;
  st >>>= 2;
  const nBUSACK = (st & 1) as 0 | 1;
  st >>>= 1;
  const nHALT = (st & 1) as 0 | 1;
  st >>>= 1;
  const nRFSH = (st & 1) as 0 | 1;
  st >>>= 1;
  const nM1 = st as 0 | 1;

  return {
    hc: hcs[idx],
    nM1,
    nRFSH,
    nHALT,
    nBUSACK,
    nMREQ,
    nIORQ,
    nRD,
    nWR,
    nINT,
    nNMI,
    nRESET,
    nBUSRQ,
    nWAIT,
    addr: addrTri ? undefined : addrArr[idx],
    data: dataTri ? undefined : dataArr[idx],
  };
}

// ── Buffer ───────────────────────────────────────────────────────

export class HwTraceBuffer {
  private enabled: boolean;
  /** Total ring slots. Power of two — `_mask = _capacity - 1`. */
  private readonly _capacity: number;
  /** Bitmask for `& _mask` wrap of the write index. */
  private readonly _mask: number;
  /** Parallel ring arrays — pulled into locals on the hot path. */
  private readonly _hcs: Float64Array;
  private readonly _state: Uint32Array;
  private readonly _addr: Uint16Array;
  private readonly _data: Uint8Array;
  /** Index of the most recently written slot. `-1` until first record. */
  private head = -1;
  /** Index of the oldest valid slot. Meaningful only when `_size > 0`. */
  private tail = 0;
  /** Snapshots containing valid data (`0..capacity`). */
  private _size = 0;
  private _version = 0;

  constructor(cfg: HwTraceConfig) {
    const cap = cfg.capacity;
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError(
        `HwTraceConfig.capacity must be a positive integer: ${cap}`,
      );
    }
    if ((cap & (cap - 1)) !== 0) {
      throw new RangeError(
        `HwTraceConfig.capacity must be a power of two: ${cap}`,
      );
    }
    this.enabled = cfg.enabled;
    this._capacity = cap;
    this._mask = cap - 1;
    // hcs uses Float64 so we never wrap at 2^32 HCs (~3.5 min at 20 MHz).
    // Float64 holds exact integers up to 2^53 — effectively unlimited.
    this._hcs = new Float64Array(cap);
    this._state = new Uint32Array(cap);
    this._addr = new Uint16Array(cap);
    this._data = new Uint8Array(cap);
  }

  /**
   * Capture the current bus state at the HC stored in `hcBox[0]`,
   * reading straight off the live `bus` readout (`cpu.bus` in
   * production) plus the separately-injected `nNMI` — no intermediate
   * sample object. Compares against the snapshot at the current head;
   * if anything changed, advances head by one (mask-wrapped) and
   * stores a fresh snapshot, evicting the oldest record when the ring
   * is full. `enabled === false` makes this a no-op before touching
   * the bus, so disabled capture costs one comparison per edge.
   *
   * `hcBox` is passed by reference so the HC stamp travels from the
   * runloop to the `_hcs[idx] = hcBox[0]` write as a pure
   * Float64Array→Float64Array copy. A plain `hc: number` argument
   * would materialize a HeapNumber on the call boundary once HC
   * exceeds V8's SMI range (~2.1B / ~52s at full speed). Tests can
   * wrap a one-shot box via `recordSample` in `busSampleTestUtil`.
   */
  record(bus: BusReadout, nNMI: 0 | 1, hcBox: ReadonlyHcBox): void {
    if (!this.enabled) return;

    // Read addr/data and the tristate strobes once into locals — used by
    // both the packing below and the equality / write paths.
    const addr = bus.addr;
    const data = bus.data;
    const nMREQ = bus.nMREQ;
    const nIORQ = bus.nIORQ;
    const nRD = bus.nRD;
    const nWR = bus.nWR;

    // Inline pack. 19-bit result stays SMI.
    let packedState: number = bus.nM1;
    packedState = (packedState << 1) | bus.nRFSH;
    packedState = (packedState << 1) | bus.nHALT;
    packedState = (packedState << 1) | bus.nBUSACK;
    packedState = (packedState << 2) | (nMREQ === undefined ? 2 : nMREQ);
    packedState = (packedState << 2) | (nIORQ === undefined ? 2 : nIORQ);
    packedState = (packedState << 2) | (nRD === undefined ? 2 : nRD);
    packedState = (packedState << 2) | (nWR === undefined ? 2 : nWR);
    packedState = (packedState << 1) | bus.nINT;
    packedState = (packedState << 1) | nNMI;
    packedState = (packedState << 1) | bus.nRESET;
    packedState = (packedState << 1) | bus.nBUSRQ;
    packedState = (packedState << 1) | bus.nWAIT;
    packedState = (packedState << 1) | (addr === undefined ? 1 : 0);
    packedState = (packedState << 1) | (data === undefined ? 1 : 0);

    // Hoist the TypedArrays into locals — one property dereference per
    // record instead of per-write.
    const stateArr = this._state;
    const hcsArr = this._hcs;
    const addrArr = this._addr;
    const dataArr = this._data;

    const head = this.head;
    if (head < 0) {
      // First-ever record — claim slot 0; tail is already 0.
      this.head = 0;
      this._size = 1;
      hcsArr[0] = hcBox[0];
      stateArr[0] = packedState;
      // Tristate slots are left stale on purpose — `readSnapshot`
      // consults the addrTri/dataTri bits in `_state` and returns
      // `undefined` then.
      if (addr !== undefined) addrArr[0] = addr;
      if (data !== undefined) dataArr[0] = data;
      this._version++;
      return;
    }

    // Inline equality check against the current head. Nothing-changed →
    // no record, no version bump.
    if (
      stateArr[head] === packedState &&
      (addr === undefined || addrArr[head] === addr) &&
      (data === undefined || dataArr[head] === data)
    ) {
      return;
    }

    // Mask-wrap advance. `_mask = capacity - 1`, capacity power-of-two.
    const mask = this._mask;
    const newHead = (head + 1) & mask;
    if (this._size < this._capacity) {
      this._size++;
    } else {
      // Ring full — evict oldest by advancing tail.
      this.tail = (this.tail + 1) & mask;
    }
    this.head = newHead;
    hcsArr[newHead] = hcBox[0];
    stateArr[newHead] = packedState;
    if (addr !== undefined) addrArr[newHead] = addr;
    if (data !== undefined) dataArr[newHead] = data;
    this._version++;
  }

  /**
   * Yields snapshot records with `lo <= hc <= hi` in ascending HC order.
   * Cold path — allocates one record per yield. Records are
   * HC-ascending along the logical `[tail, …, tail+size-1] & mask`
   * walk; the physical array is broken by at most one wrap point.
   */
  *rangeView(lo: number, hi: number): Iterable<BusSnapshotRecord> {
    if (hi < lo) return;
    const size = this._size;
    if (size === 0) return;
    const mask = this._mask;
    const tail = this.tail;
    const hcsArr = this._hcs;
    const stateArr = this._state;
    const addrArr = this._addr;
    const dataArr = this._data;
    for (let i = 0; i < size; i++) {
      const idx = (tail + i) & mask;
      const hc = hcsArr[idx];
      if (hc < lo) continue;
      if (hc > hi) return;
      yield readSnapshot(hcsArr, stateArr, addrArr, dataArr, idx);
    }
  }

  /**
   * The most recent snapshot strictly before `hc`, or `undefined` when
   * the buffer holds nothing older. Every snapshot is a FULL bus state,
   * so this single record carries the carry-forward value for every
   * signal — the renderer seeds its pre-window levels from this instead
   * of walking (and allocating a record per) snapshot from the oldest.
   * Cold path, but allocates exactly one record: the linear scan only
   * reads TypedArrays.
   */
  latestBefore(hc: number): BusSnapshotRecord | undefined {
    const size = this._size;
    if (size === 0) return undefined;
    const mask = this._mask;
    const tail = this.tail;
    const hcsArr = this._hcs;
    // Records are HC-ascending along the logical `[tail, tail+size)` walk
    // (the one physical wrap point falls between tail and head). Binary-
    // search for the first logical index whose HC is >= target; the
    // predecessor (if any) is the answer.
    let lo = 0;
    let hi = size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (hcsArr[(tail + mid) & mask] < hc) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return undefined;
    const foundIdx = (tail + lo - 1) & mask;
    return readSnapshot(hcsArr, this._state, this._addr, this._data, foundIdx);
  }

  oldestHc(): number | undefined {
    return this._size === 0 ? undefined : this._hcs[this.tail];
  }

  newestHc(): number | undefined {
    return this.head < 0 ? undefined : this._hcs[this.head];
  }

  /**
   * True when the ring holds no records (nothing ever written, or
   * `clear()`ed). The display uses this to render nothing rather than
   * carrying a stale level across a window a later run advanced past
   * ("dead lines"); the store uses it to decide whether disabling
   * capture should offer to save before zeroing.
   */
  isEmpty(): boolean {
    return this._size === 0;
  }

  version(): number {
    return this._version;
  }

  /**
   * Empty the ring. Slot data is left in place — `head`/`tail`/`_size`
   * are the validity bound and the next `record()` starts cleanly at
   * slot 0. Called by `zeroHC` (time-stamped buffers clear
   * on zero-HC).
   */
  clear(): void {
    this.head = -1;
    this.tail = 0;
    this._size = 0;
    this._version++;
  }

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    // History captured before the toggle stays in the ring — re-enabling
    // resumes appending past it.
    this._version++;
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  // ── Diagnostics ──

  /** Total ring slots (the cap on retained snapshots). */
  capacity(): number {
    return this._capacity;
  }

  /** Snapshots currently retained (0..capacity). */
  size(): number {
    return this._size;
  }
}
