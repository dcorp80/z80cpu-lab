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
// Physical layout: each chunk stores one TypedArray per signal,
// parallel-indexed by position. Semantically per-position (each position
// holds a full snapshot); under the hood a row-store would have looked
// the same. Per-signal columns keep `equals()` and `writeSnapshot()`
// cache-friendly without changing the API.
//
// HC=0 is never recorded — the very first `record(curr, hc)` call comes
// from the loop AFTER its first clockEdge with hc ≥ 1.

import type { HwTraceConfig } from "../config/defaults.ts";

// ── Signal taxonomy ──────────────────────────────────────────────

export type Tri = 0 | 1 | 2; // L | H | Z

/** CPU output pins always defined (no tristate). */
export const OUTPUT_BIT_SIGNALS = ["nM1", "nRFSH", "nHALT", "nBUSACK"] as const;

/** CPU output pins that tristate during bus grant. */
export const OUTPUT_TRI_SIGNALS = ["nMREQ", "nIORQ", "nRD", "nWR"] as const;

/** CPU input pins (always 0|1 on the sample side; the bus surface only
 *  exposes nINT/nRESET/nBUSRQ/nWAIT — nNMI is sampled from
 *  `store.inputPins.nNMI` per DESIGN §2.1). */
export const INPUT_BIT_SIGNALS = [
  "nINT",
  "nNMI",
  "nRESET",
  "nBUSRQ",
  "nWAIT",
] as const;

/** Multi-bit bus values; undefined ⇒ tristate during a bus grant. */
export const BUS_VALUE_SIGNALS = ["addr", "data"] as const;

export type OutputBitSignal = (typeof OUTPUT_BIT_SIGNALS)[number];
export type OutputTriSignal = (typeof OUTPUT_TRI_SIGNALS)[number];
export type InputBitSignal = (typeof INPUT_BIT_SIGNALS)[number];
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
 * Per-signal TypedArrays are parallel-indexed by position. `pointer`
 * is the index of the **last** written position; `-1` means the chunk
 * is empty. Valid positions are `[0..pointer]`.
 *
 * Recycling on rotation overwrites from position 0; we don't clear
 * trailing data because readers honor `pointer` as the bound.
 */
class FrameChunk {
  pointer = -1;
  readonly hcs: Float64Array;
  // 1-bit and tri-bit values fit in u8. Tri uses 0|1|2.
  readonly nM1: Uint8Array;
  readonly nRFSH: Uint8Array;
  readonly nHALT: Uint8Array;
  readonly nBUSACK: Uint8Array;
  readonly nMREQ: Uint8Array;
  readonly nIORQ: Uint8Array;
  readonly nRD: Uint8Array;
  readonly nWR: Uint8Array;
  readonly nINT: Uint8Array;
  readonly nNMI: Uint8Array;
  readonly nRESET: Uint8Array;
  readonly nBUSRQ: Uint8Array;
  readonly nWAIT: Uint8Array;
  // 16-bit addr + tristate flag; 8-bit data + tristate flag.
  readonly addr: Uint16Array;
  readonly addrTri: Uint8Array;
  readonly data: Uint8Array;
  readonly dataTri: Uint8Array;

  constructor(chunkSize: number) {
    // hcs uses Float64 so we never wrap at 2^32 HCs (~3.5 min at 20MHz
    // HC). Float64 holds exact integers up to 2^53 — effectively
    // unlimited. The 8-byte cost is tiny at MVP chunk sizes.
    this.hcs = new Float64Array(chunkSize);
    this.nM1 = new Uint8Array(chunkSize);
    this.nRFSH = new Uint8Array(chunkSize);
    this.nHALT = new Uint8Array(chunkSize);
    this.nBUSACK = new Uint8Array(chunkSize);
    this.nMREQ = new Uint8Array(chunkSize);
    this.nIORQ = new Uint8Array(chunkSize);
    this.nRD = new Uint8Array(chunkSize);
    this.nWR = new Uint8Array(chunkSize);
    this.nINT = new Uint8Array(chunkSize);
    this.nNMI = new Uint8Array(chunkSize);
    this.nRESET = new Uint8Array(chunkSize);
    this.nBUSRQ = new Uint8Array(chunkSize);
    this.nWAIT = new Uint8Array(chunkSize);
    this.addr = new Uint16Array(chunkSize);
    // Parallel tristate flag — Uint typed arrays can't hold `undefined`,
    // so we burn a u8 per position for addr and data each. 1 = tristate,
    // 0 = numeric value valid.
    this.addrTri = new Uint8Array(chunkSize);
    this.data = new Uint8Array(chunkSize);
    this.dataTri = new Uint8Array(chunkSize);
  }

  reset(): void {
    this.pointer = -1;
    // Buffers stay — `pointer` is the validity bound.
  }
}

// `nMREQ|nIORQ|nRD|nWR` arrive as `0|1|undefined` (the CPU's tristate
// encoding); we store them as `Tri` with `undefined → 2`. Inlining this
// at the read sites (vs a `tri()` helper call) keeps the per-edge compare
// branch-light.
function writeSnapshot(
  chunk: FrameChunk,
  pos: number,
  bus: BusReadout,
  nNMI: 0 | 1,
  hc: number,
): void {
  chunk.hcs[pos] = hc;
  chunk.nM1[pos] = bus.nM1;
  chunk.nRFSH[pos] = bus.nRFSH;
  chunk.nHALT[pos] = bus.nHALT;
  chunk.nBUSACK[pos] = bus.nBUSACK;
  chunk.nMREQ[pos] = bus.nMREQ === undefined ? 2 : bus.nMREQ;
  chunk.nIORQ[pos] = bus.nIORQ === undefined ? 2 : bus.nIORQ;
  chunk.nRD[pos] = bus.nRD === undefined ? 2 : bus.nRD;
  chunk.nWR[pos] = bus.nWR === undefined ? 2 : bus.nWR;
  chunk.nINT[pos] = bus.nINT;
  chunk.nNMI[pos] = nNMI;
  chunk.nRESET[pos] = bus.nRESET;
  chunk.nBUSRQ[pos] = bus.nBUSRQ;
  chunk.nWAIT[pos] = bus.nWAIT;
  if (bus.addr === undefined) {
    chunk.addr[pos] = 0;
    chunk.addrTri[pos] = 1;
  } else {
    chunk.addr[pos] = bus.addr;
    chunk.addrTri[pos] = 0;
  }
  if (bus.data === undefined) {
    chunk.data[pos] = 0;
    chunk.dataTri[pos] = 1;
  } else {
    chunk.data[pos] = bus.data;
    chunk.dataTri[pos] = 0;
  }
}

function snapshotEquals(
  chunk: FrameChunk,
  pos: number,
  bus: BusReadout,
  nNMI: 0 | 1,
): boolean {
  if (chunk.nM1[pos] !== bus.nM1) return false;
  if (chunk.nRFSH[pos] !== bus.nRFSH) return false;
  if (chunk.nHALT[pos] !== bus.nHALT) return false;
  if (chunk.nBUSACK[pos] !== bus.nBUSACK) return false;
  if (chunk.nMREQ[pos] !== (bus.nMREQ === undefined ? 2 : bus.nMREQ))
    return false;
  if (chunk.nIORQ[pos] !== (bus.nIORQ === undefined ? 2 : bus.nIORQ))
    return false;
  if (chunk.nRD[pos] !== (bus.nRD === undefined ? 2 : bus.nRD)) return false;
  if (chunk.nWR[pos] !== (bus.nWR === undefined ? 2 : bus.nWR)) return false;
  if (chunk.nINT[pos] !== bus.nINT) return false;
  if (chunk.nNMI[pos] !== nNMI) return false;
  if (chunk.nRESET[pos] !== bus.nRESET) return false;
  if (chunk.nBUSRQ[pos] !== bus.nBUSRQ) return false;
  if (chunk.nWAIT[pos] !== bus.nWAIT) return false;
  // addr / data — tristate flag must match too.
  if (bus.addr === undefined) {
    if (chunk.addrTri[pos] !== 1) return false;
  } else {
    if (chunk.addrTri[pos] !== 0) return false;
    if (chunk.addr[pos] !== bus.addr) return false;
  }
  if (bus.data === undefined) {
    if (chunk.dataTri[pos] !== 1) return false;
  } else {
    if (chunk.dataTri[pos] !== 0) return false;
    if (chunk.data[pos] !== bus.data) return false;
  }
  return true;
}

function readSnapshot(chunk: FrameChunk, pos: number): BusSnapshotRecord {
  return {
    hc: chunk.hcs[pos],
    nM1: chunk.nM1[pos] as 0 | 1,
    nRFSH: chunk.nRFSH[pos] as 0 | 1,
    nHALT: chunk.nHALT[pos] as 0 | 1,
    nBUSACK: chunk.nBUSACK[pos] as 0 | 1,
    nMREQ: chunk.nMREQ[pos] as Tri,
    nIORQ: chunk.nIORQ[pos] as Tri,
    nRD: chunk.nRD[pos] as Tri,
    nWR: chunk.nWR[pos] as Tri,
    nINT: chunk.nINT[pos] as 0 | 1,
    nNMI: chunk.nNMI[pos] as 0 | 1,
    nRESET: chunk.nRESET[pos] as 0 | 1,
    nBUSRQ: chunk.nBUSRQ[pos] as 0 | 1,
    nWAIT: chunk.nWAIT[pos] as 0 | 1,
    addr: chunk.addrTri[pos] === 1 ? undefined : chunk.addr[pos],
    data: chunk.dataTri[pos] === 1 ? undefined : chunk.data[pos],
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
   * Capture the current bus state at `hc`, reading straight off the live
   * `bus` readout (`cpu.bus` in production) plus the separately-injected
   * `nNMI` — no intermediate sample object. Compares against the snapshot
   * at the current write position; if anything changed, advances and
   * stores a fresh snapshot (rotating chunks on overflow). `mode ===
   * 'disabled'` makes this a no-op before touching the bus, so disabled
   * capture costs one comparison per edge.
   */
  record(bus: BusReadout, nNMI: 0 | 1, hc: number): void {
    if (this.mode === "disabled") return;
    if (this.head < 0) {
      // First-ever record — open chunk[0] and store at position 0.
      this.head = 0;
      this._size = 1;
      this.chunks[0].pointer = 0;
      writeSnapshot(this.chunks[0], 0, bus, nNMI, hc);
      this._version++;
      return;
    }
    const chunk = this.chunks[this.head];
    const pos = chunk.pointer;
    if (snapshotEquals(chunk, pos, bus, nNMI)) {
      // Nothing changed — no record, no version bump. The renderer's
      // "value at HC=X" is unchanged.
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
      writeSnapshot(newChunk, 0, bus, nNMI, hc);
    } else {
      chunk.pointer = newPos;
      writeSnapshot(chunk, newPos, bus, nNMI, hc);
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
