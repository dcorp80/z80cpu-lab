// Append-only, fixed-capacity instruction trace ring (DESIGN §3.1).
// Pre-allocated record pool; `push` mutates in place — zero allocations on
// the hot path. Records are reused on wrap, so consumers must treat any
// reference from `at()` as transient (re-fetch when `version()` changes).
//
// HC ordering: `loop.onInstruction` fires monotonically in HC, so the
// oldest-first view exposed by `at()` is naturally sorted ascending by
// `hc`. `findByHc` exploits that with binary search across the circular
// indexing.

import type { InstructionTrace, M1Type } from "@dcorp80/z80cpu-debug";

/**
 * One stored instruction. Field set matches `InstructionTrace` plus
 * `hc` (when the trace was committed) and a lazy `disasmText` slot the
 * section fills on first render. The slot is null on push so the next
 * read recomputes against the (possibly recycled) bytes.
 */
export class TraceRecord {
  /** Half-cycle at which `onInstructionComplete` fired (loop.hc). */
  hc = 0;
  /** Fetch address of this instruction's first M1 byte. */
  startAddr = 0;
  /** Pre-allocated 4-slot byte buffer. Z80's longest real instruction is
   *  4 bytes; wasted-prefix M1s split into separate traces upstream. */
  readonly bytes: number[] = [0, 0, 0, 0];
  /** Valid bytes are `bytes[0..length)`. */
  length = 0;
  m1Type: M1Type = "normal";
  /** Where execution went next — captured at the next M1's T1_0
   *  (DESIGN §2.6 / CLAUDE.md "trace timing model"). */
  nextPc = 0;
  /** HC consumed by this instruction (the trace's own `hc` field). */
  instHc = 0;
  /** Lazy disasm text — cleared on push, filled on first read. */
  disasmText: string | null = null;
}

export class TraceRing {
  private readonly buf: TraceRecord[];
  private readonly cap: number;
  private head = 0; // next write slot
  private filled = false; // wrapped at least once
  private _version = 0;

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError(`TraceRing cap must be a positive integer: ${cap}`);
    }
    this.cap = cap;
    this.buf = Array.from({ length: cap }, () => new TraceRecord());
  }

  push(src: InstructionTrace, hcAtComplete: number): void {
    const r = this.buf[this.head];
    r.hc = hcAtComplete;
    r.startAddr = src.startAddr;
    r.length = src.length;
    // `src.bytes` is a fixed-size 4-slot Array on InstructionTrace. We
    // copy all 4 unconditionally — bytes beyond `length` are stale but
    // never read by consumers (which honor `length`), and a fixed-iter
    // copy is cheaper than a conditional.
    r.bytes[0] = src.bytes[0];
    r.bytes[1] = src.bytes[1];
    r.bytes[2] = src.bytes[2];
    r.bytes[3] = src.bytes[3];
    r.m1Type = src.m1Type;
    r.nextPc = src.nextPc;
    r.instHc = src.hc;
    r.disasmText = null;
    this.head = (this.head + 1) % this.cap;
    if (this.head === 0) this.filled = true;
    this._version++;
  }

  size(): number {
    return this.filled ? this.cap : this.head;
  }

  /** Oldest-first index. `at(0)` is the oldest extant record. */
  at(i: number): TraceRecord | undefined {
    const n = this.size();
    if (i < 0 || i >= n) return undefined;
    const start = this.filled ? this.head : 0;
    return this.buf[(start + i) % this.cap];
  }

  oldestHc(): number | undefined {
    const r = this.at(0);
    return r?.hc;
  }

  newestHc(): number | undefined {
    const n = this.size();
    if (n === 0) return undefined;
    return this.at(n - 1)?.hc;
  }

  /**
   * Latest record with `hc <= target`, via binary search over the
   * oldest-first view. Returns undefined when the ring is empty or
   * `target` precedes every extant record.
   */
  findByHc(target: number): TraceRecord | undefined {
    const n = this.size();
    if (n === 0) return undefined;
    let lo = 0;
    let hi = n - 1;
    // Standard "rightmost ≤ target" — invariant: answer is in [lo, hi]
    // or strictly less than lo (no record qualifies).
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rec = this.at(mid);
      if (rec === undefined) break;
      if (rec.hc <= target) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans < 0 ? undefined : this.at(ans);
  }

  version(): number {
    return this._version;
  }

  clear(): void {
    this.head = 0;
    this.filled = false;
    this._version++;
  }

  /** Capacity is fixed at construction. Exposed for tests / diagnostics. */
  capacity(): number {
    return this.cap;
  }
}
