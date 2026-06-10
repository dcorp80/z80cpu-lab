// HW-trace ring buffer — per-position-snapshot model (REQ §6.4, DESIGN §3.2).
//
// Each chunk holds an array of full bus snapshots in HC-ascending order;
// each snapshot is the complete bus state at one HC. The recorder
// (boot.tsx's postEdge wrapper) calls `record(cpu.bus, nNMI, hc)` once per
// loop edge — reading the live bus directly, no intermediate copy; the
// buffer:
//
//   - First record into a fresh chunk → snapshot stored at position 0.
//   - No-change record → no advance, no write.
//   - State-change record → advance pointer, store new snapshot.
//   - Position past chunkSize → rotate to next chunk in the ring (head
//     advances, oldest chunk evicted if size === ringChunks).
//
// Chunks are entirely decoupled from rAF frames — chunk boundaries are
// driven by record volume, not time. Step mode accumulates into one
// chunk across many steps; full-speed run fills a chunk in milliseconds.
//
// Physical layout per chunk: one Float64Array for HCs, plus three
// parallel TypedArrays indexed by position:
//   - `state` (Uint32Array) — every 1-bit and tri-bit signal AND the
//     addr/data tristate flags packed into a single integer (layout
//     inlined in `record()` below). One compare per record replaces
//     fifteen TypedArray reads on the hot path.
//   - `addr` (Uint16Array), `data` (Uint8Array) — bus values. During a
//     bus grant the value is `undefined`; the corresponding slot is left
//     stale and the tristate flag in `state` selects between "use slot"
//     and "report undefined" on read.
//
// HC=0 is never recorded — the very first `record(curr, hc)` call comes
// from the loop AFTER its first clockEdge with hc ≥ 1.

import type { HwTraceConfig } from "../config/defaults.ts";
import { INPUT_PIN_NAMES, type InputPinName } from "./bus.ts";

// ── Signal taxonomy ──────────────────────────────────────────────

export type Tri = 0 | 1 | 2; // L | H | Z

/** CPU output pins always defined (no tristate). */
export const OUTPUT_BIT_SIGNALS = ["nM1", "nRFSH", "nHALT", "nBUSACK"] as const;

/** CPU output pins that tristate during bus grant. */
export const OUTPUT_TRI_SIGNALS = ["nMREQ", "nIORQ", "nRD", "nWR"] as const;

/** CPU input pins (always 0|1 on the sample side; the bus surface only
 *  exposes nINT/nRESET/nBUSRQ/nWAIT — nNMI is sampled from the bus's
 *  authoritative pin state per DESIGN §2.1). Aliased to `INPUT_PIN_NAMES`
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
 * `record()` path never builds these — it reads/writes the chunk's
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
 * injected as a separate `record` argument (DESIGN §2.1).
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

// ── Storage ──────────────────────────────────────────────────────

/**
 * One chunk = `chunkSize` positions, each holding a full bus snapshot.
 * Parallel arrays are indexed by position. `pointer` is the index of the
 * **last** written position; `-1` means the chunk is empty. Valid
 * positions are `[0..pointer]`.
 *
 * Recycling on rotation overwrites from position 0; we don't clear
 * trailing data because readers honor `pointer` as the bound.
 */
class FrameChunk {
  pointer = -1;
  readonly hcs: Float64Array;
  /** Every 1-bit / tri-bit signal plus the addr/data tristate flags
   *  packed into one integer per position. Pack layout inlined in
   *  `HwTraceBuffer.record`; `readSnapshot` inlines the inverse. */
  readonly state: Uint32Array;
  /** Bus values. Slots are only written when the bus is driven; during
   *  a tristate the slot is left stale and `state`'s addrTri/dataTri
   *  bit selects "report undefined" on read. */
  readonly addr: Uint16Array;
  readonly data: Uint8Array;

  constructor(chunkSize: number) {
    // hcs uses Float64 so we never wrap at 2^32 HCs (~3.5 min at 20MHz
    // HC). Float64 holds exact integers up to 2^53 — effectively
    // unlimited. The 8-byte cost is tiny at MVP chunk sizes.
    this.hcs = new Float64Array(chunkSize);
    this.state = new Uint32Array(chunkSize);
    this.addr = new Uint16Array(chunkSize);
    this.data = new Uint8Array(chunkSize);
  }

  reset(): void {
    this.pointer = -1;
    // Buffers stay — `pointer` is the validity bound.
  }
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

function readSnapshot(chunk: FrameChunk, pos: number): BusSnapshotRecord {
  // Unpack in reverse of packBusState — LSB first.
  let st = chunk.state[pos];
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
    hc: chunk.hcs[pos],
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
    addr: addrTri ? undefined : chunk.addr[pos],
    data: dataTri ? undefined : chunk.data[pos],
  };
}

// ── Buffer ───────────────────────────────────────────────────────

export class HwTraceBuffer {
  private mode: "disabled" | "ring";
  private readonly chunkSize: number;
  private readonly ringChunks: number;
  private readonly chunks: FrameChunk[];
  /** Current write chunk index. `-1` until the first record. */
  private head = -1;
  /** Oldest written chunk index. */
  private tail = 0;
  /** Chunks containing valid data (`0..chunks.length`). */
  private _size = 0;
  private _version = 0;

  constructor(cfg: HwTraceConfig) {
    if (!Number.isInteger(cfg.ringChunks) || cfg.ringChunks <= 0) {
      throw new RangeError(
        `HwTraceConfig.ringChunks must be a positive integer: ${cfg.ringChunks}`,
      );
    }
    if (!Number.isInteger(cfg.chunkSize) || cfg.chunkSize <= 0) {
      throw new RangeError(
        `HwTraceConfig.chunkSize must be a positive integer: ${cfg.chunkSize}`,
      );
    }
    this.mode = cfg.mode;
    this.chunkSize = cfg.chunkSize;
    this.ringChunks = cfg.ringChunks;
    // Pre-allocate the full ring. No pool/free-list split — head/tail
    // walk a fixed array and overwrite on recycle.
    this.chunks = Array.from(
      { length: cfg.ringChunks },
      () => new FrameChunk(cfg.chunkSize),
    );
  }

  /**
   * Capture the current bus state at the HC stored in `hcBox[0]`,
   * reading straight off the live `bus` readout (`cpu.bus` in
   * production) plus the separately-injected `nNMI` — no intermediate
   * sample object. Compares against the snapshot at the current write
   * position; if anything changed, advances and stores a fresh
   * snapshot (rotating chunks on overflow). `mode === 'disabled'`
   * makes this a no-op before touching the bus, so disabled capture
   * costs one comparison per edge.
   *
   * `hcBox` is passed by reference so the HC stamp travels from the
   * runloop to the `chunk.hcs[pos] = hcBox[0]` write as a pure
   * Float64Array→Float64Array copy. A plain `hc: number` argument
   * would materialize a HeapNumber on the call boundary once HC
   * exceeds V8's SMI range (~2.1B / ~52s at full speed). Tests can
   * wrap a one-shot box via `recordSample` in `busSampleTestUtil`.
   */
  record(bus: BusReadout, nNMI: 0 | 1, hcBox: Float64Array): void {
    if (this.mode === "disabled") return;

    // Read addr/data once into locals — used by both the packing below
    // and the equality / write paths. Avoids re-reading bus properties
    // multiple times across what used to be three function boundaries.
    const addr = bus.addr;
    const data = bus.data;
    const nMREQ = bus.nMREQ;
    const nIORQ = bus.nIORQ;
    const nRD = bus.nRD;
    const nWR = bus.nWR;

    // Inline pack (was packBusState). 19-bit result stays SMI.
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

    if (this.head < 0) {
      // First-ever record — open chunk[0] and store at position 0.
      this.head = 0;
      this._size = 1;
      const first = this.chunks[0];
      first.pointer = 0;
      first.hcs[0] = hcBox[0];
      first.state[0] = packedState;
      // Tristate slots are left stale on purpose — `readSnapshot`
      // consults the addrTri/dataTri bits in `state` and returns
      // `undefined` then.
      if (addr !== undefined) first.addr[0] = addr;
      if (data !== undefined) first.data[0] = data;
      this._version++;
      return;
    }

    const chunk = this.chunks[this.head];
    const pos = chunk.pointer;

    // Inline equality check (was snapshotEquals). Nothing-changed →
    // no record, no version bump.
    if (
      chunk.state[pos] === packedState &&
      (addr === undefined || chunk.addr[pos] === addr) &&
      (data === undefined || chunk.data[pos] === data)
    ) {
      return;
    }

    const newPos = pos + 1;
    if (newPos >= this.chunkSize) {
      // Overflow — rotate to next chunk in the ring.
      this.head = (this.head + 1) % this.chunks.length;
      if (this._size < this.chunks.length) {
        this._size++;
      } else {
        // Ring full — evict oldest by advancing tail.
        this.tail = (this.tail + 1) % this.chunks.length;
      }
      const newChunk = this.chunks[this.head];
      newChunk.pointer = 0;
      newChunk.hcs[0] = hcBox[0];
      newChunk.state[0] = packedState;
      if (addr !== undefined) newChunk.addr[0] = addr;
      if (data !== undefined) newChunk.data[0] = data;
    } else {
      chunk.pointer = newPos;
      chunk.hcs[newPos] = hcBox[0];
      chunk.state[newPos] = packedState;
      if (addr !== undefined) chunk.addr[newPos] = addr;
      if (data !== undefined) chunk.data[newPos] = data;
    }
    this._version++;
  }

  /**
   * Yields snapshot records with `lo <= hc <= hi` in ascending HC order.
   * Cold path — allocates one record per yield. Callers walking large
   * ranges should be prepared for that.
   */
  *rangeView(lo: number, hi: number): Iterable<BusSnapshotRecord> {
    if (hi < lo) return;
    if (this._size === 0) return;
    for (let i = 0; i < this._size; i++) {
      const idx = (this.tail + i) % this.chunks.length;
      const chunk = this.chunks[idx];
      if (chunk.pointer < 0) continue;
      // Each chunk's positions are HC-ascending; positions are densely
      // packed in `[0..pointer]`.
      const firstHc = chunk.hcs[0];
      const lastHc = chunk.hcs[chunk.pointer];
      if (lastHc < lo) continue; // entirely before window
      if (firstHc > hi) return; // entirely past window (and so are later chunks)
      for (let p = 0; p <= chunk.pointer; p++) {
        const hc = chunk.hcs[p];
        if (hc < lo) continue;
        if (hc > hi) return;
        yield readSnapshot(chunk, p);
      }
    }
  }

  /**
   * The most recent snapshot strictly before `hc`, or `undefined` when
   * the buffer holds nothing older. Every snapshot is a FULL bus state,
   * so this single record carries the carry-forward value for every
   * signal — the renderer seeds its pre-window levels from this instead
   * of walking (and allocating a record per) snapshot from the oldest.
   * Cold path, but allocates exactly one record: the scan over earlier
   * positions only reads TypedArrays.
   */
  latestBefore(hc: number): BusSnapshotRecord | undefined {
    if (this._size === 0) return undefined;
    let foundChunk = -1;
    let foundPos = -1;
    for (let i = 0; i < this._size; i++) {
      const idx = (this.tail + i) % this.chunks.length;
      const chunk = this.chunks[idx];
      if (chunk.pointer < 0) continue;
      // Chunks are globally HC-ascending: once a chunk starts at/after
      // `hc`, it and every later chunk are out of range.
      if (chunk.hcs[0] >= hc) break;
      // Walk back to the last position with hcs[p] < hc. A later chunk
      // that also straddles overwrites this, keeping the latest match.
      let p = chunk.pointer;
      while (p >= 0 && chunk.hcs[p] >= hc) p--;
      if (p >= 0) {
        foundChunk = idx;
        foundPos = p;
      }
    }
    if (foundChunk < 0) return undefined;
    return readSnapshot(this.chunks[foundChunk], foundPos);
  }

  oldestHc(): number | undefined {
    if (this._size === 0) return undefined;
    const chunk = this.chunks[this.tail];
    return chunk.pointer < 0 ? undefined : chunk.hcs[0];
  }

  newestHc(): number | undefined {
    if (this.head < 0) return undefined;
    const chunk = this.chunks[this.head];
    return chunk.pointer < 0 ? undefined : chunk.hcs[chunk.pointer];
  }

  /**
   * True when the ring holds no records — the head/tail span is empty
   * (nothing ever written, or `clear()`ed). The display uses this to
   * render nothing rather than carrying a stale level across a window a
   * later run advanced past ("dead lines"); the store uses it to decide
   * whether disabling capture should offer to save before zeroing.
   */
  isEmpty(): boolean {
    return this._size === 0;
  }

  version(): number {
    return this._version;
  }

  /**
   * Empty the buffer. All chunks return to the "fresh" state and the
   * next `record()` reopens chunk[0]. Called by `zeroHC` (REQ §7.3 —
   * time-stamped buffers clear on zero-HC).
   */
  clear(): void {
    for (const c of this.chunks) c.reset();
    this.head = -1;
    this.tail = 0;
    this._size = 0;
    this._version++;
  }

  setMode(mode: "disabled" | "ring"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // History captured before the toggle stays in the ring — re-enabling
    // resumes appending past it.
    this._version++;
  }

  getMode(): "disabled" | "ring" {
    return this.mode;
  }

  // ── Diagnostics ──

  ringCapacity(): number {
    return this.ringChunks;
  }

  chunkCapacity(): number {
    return this.chunkSize;
  }

  /** Number of chunks containing valid data. */
  size(): number {
    return this._size;
  }

  /** Total number of recorded snapshots across all live chunks. */
  recordedCount(): number {
    if (this._size === 0) return 0;
    let n = 0;
    for (let i = 0; i < this._size; i++) {
      const idx = (this.tail + i) % this.chunks.length;
      const chunk = this.chunks[idx];
      if (chunk.pointer >= 0) n += chunk.pointer + 1;
    }
    return n;
  }
}
