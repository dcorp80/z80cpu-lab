// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

/**
 * A read-only handle to a half-cycle counter slot. Consumers own the
 * storage and the tick/reset policy — `Z80Breakpoints` (and any other
 * future debug helper that needs HC) only reads `box[index]`.
 *
 * The slot is a `Float64Array` cell rather than a plain `number` field
 * so the value stays unboxed once it exceeds V8's SMI range (~2.1B on
 * 64-bit, ~52s of full-speed run at ~40M edges/sec). A `number` field
 * past that boundary HeapNumber-allocates on every `++` (~640 MB/sec of
 * allocation), which shows up as GC sawtooth in run-mode profilers.
 *
 * The `{ box, index }` shape (instead of just `Float64Array`) lets a
 * single buffer hold counters for multiple CPUs in a multi-CPU system —
 * each `(cpu_i, dbg_i, bp_i)` triple gets `{ box: shared, index: i }`,
 * no extra allocations, and each consumer reads only its own slot.
 *
 * Note: the box+index reference is captured at consumer construction;
 * swapping the underlying counter later isn't supported (rebuild the
 * consumer to retarget).
 */
export interface HcCounter {
  readonly box: Float64Array;
  readonly index: number;
}
