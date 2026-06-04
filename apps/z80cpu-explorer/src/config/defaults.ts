// Shipped low-level defaults — single source of truth for tunables the
// app hands to a constructor (loop, bus, ring). Per DESIGN §2.4 these
// stay in one place so a future Settings UI has one surface to bind
// against; no inline magic numbers.
//
// Section order is shipped config too, but it has to import the section
// modules (which transitively import the store), so keeping it here
// would create a circular import. Lives in `sections/sectionRegistry.ts`
// for that reason; a Settings UI that exposes the section list reads
// it from there.

// ── Run loop ──────────────────────────────────────────────────────

export interface LoopConfig {
  /** Wallclock budget per rAF frame (ms). REQ §4 default ~10. */
  frameBudgetMs: number;
  /**
   * How often to poll `performance.now()` for the budget check, in
   * half-cycles. Smaller = more responsive at frame edge, more overhead.
   * 1024 edges ≈ a few hundred Z80 instructions — coarse enough to amortize
   * the syscall, fine enough that we don't overrun the frame budget by much.
   */
  budgetCheckEveryEdges: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  frameBudgetMs: 10,
  budgetCheckEveryEdges: 1024,
};

// ── UI throttle cadence ───────────────────────────────────────────

/**
 * Throttled-flush cadence for run-state UI mirrors
 * (`traceRingVersionThrottled`, `insnCountThrottled`). Independent of
 * the CPU loop's rAF cadence — the CPU still runs every frame; this
 * just gates how often the UI sees the new values.
 *
 * REQ §7.5 baseline: 30 Hz. `flushEveryNFrames: 2` flushes on every
 * other rAF callback (~30 Hz on a 60 Hz display); `1` flushes every
 * frame (~60 Hz). Values >2 are valid but make the BP status line
 * and trace folded summary feel laggy without saving real CPU.
 */
export interface UiConfig {
  flushEveryNFrames: number;
}

export const DEFAULT_UI_CONFIG: UiConfig = {
  flushEveryNFrames: 2,
};

// ── Bus ───────────────────────────────────────────────────────────

/**
 * Initial-fill bytes for the bus arrays + INT vector. The bus retains
 * the config so a future `reinit()` (REQ §7.3) refills from one source
 * of truth. Each byte is masked to 8 bits at the bus boundary.
 *
 * REQ §6.6 / §6.7 mandate `FF` for mem and IO on app start and on
 * reinit; REQ §6.4 mandates `FF` for the INT vector default.
 */
export interface BusConfig {
  /** Byte every mem cell is filled with on construction / reinit. */
  memInit: number;
  /** Byte every IO cell is filled with on construction / reinit. */
  ioInit: number;
  /** Initial INT vector byte; user can edit at runtime (REQ §6.4). */
  intVectorInit: number;
}

export const DEFAULT_BUS_CONFIG: BusConfig = {
  memInit: 0xff,
  ioInit: 0xff,
  intVectorInit: 0xff,
};

// ── Instruction trace ring ────────────────────────────────────────

/**
 * Capacity of the instruction-trace ring (DESIGN §3.1). 10k records is
 * roughly 1 MB and covers ~10 ms of full-speed execution — enough for
 * "what just happened" inspection without burdening GC. Hot-path push
 * cost is fixed regardless of cap.
 */
export const DEFAULT_INSTRUCTION_RING_CAP = 10_000;

// ── Hex grid (memory + IO sections) ───────────────────────────────
//
// The grid renders a watch window centered on a user-typed address —
// `rowsBefore` rows of context above the watch row, plus the watch
// row, plus `rowsAfter` rows below. No 64K scroll, no virtualization.
// User scrolls within the rendered window via the section body's
// CSS overflow; pressing Enter on the watch input re-centers the row.
//
// Memory and IO size independently — memory windows want enough rows
// to read structures around the watch byte; IO maps are sparser and
// users typically watch one port at a time, so 3 rows is plenty.

/** Memory section — rows above watch (default 2 + 1 + 9 = 12 total). */
export const DEFAULT_MEMORY_ROWS_BEFORE = 2;
export const DEFAULT_MEMORY_ROWS_AFTER = 9;
/** IO section — rows above watch (default 1 + 1 + 1 = 3 total). */
export const DEFAULT_IO_ROWS_BEFORE = 1;
export const DEFAULT_IO_ROWS_AFTER = 1;

/**
 * Allowed bytes-per-row values for the hex grid. Restricted to powers
 * of two so row-base alignment is a single mask (`addr & ~(bpr - 1)`)
 * and CSS column tracks can be enumerated as a small fixed set.
 */
export const BYTES_PER_ROW_OPTIONS = [16, 32, 64] as const;
export type BytesPerRow = (typeof BYTES_PER_ROW_OPTIONS)[number];
export const DEFAULT_MEMORY_BYTES_PER_ROW: BytesPerRow = 16;
export const DEFAULT_IO_BYTES_PER_ROW: BytesPerRow = 16;

// ── HW trace buffer (DESIGN §3.2) ────────────────────────────────

/**
 * Capture model is binary: `'disabled'` short-circuits `record()`
 * (zero per-edge cost — see DESIGN §3.2), `'ring'` retains the most
 * recent state changes.
 *
 * The buffer is a ring of `ringChunks` chunks; each chunk holds up
 * to `chunkSize` per-edge snapshots. Chunks are decoupled from rAF
 * frames — a chunk advances only when its snapshot count hits
 * `chunkSize`, and the ring evicts the oldest chunk when the next
 * rotation would overrun. Step-mode accumulates into one chunk
 * across many steps; full-speed run fills chunks quickly.
 */
export interface HwTraceConfig {
  mode: "disabled" | "ring";
  /** Ring capacity in chunks. */
  ringChunks: number;
  /** Positions per chunk — drives chunk-rotation threshold. */
  chunkSize: number;
}

export const DEFAULT_HW_TRACE_CONFIG: HwTraceConfig = {
  mode: "ring",
  // ~1 MB total at chunkSize=4096 (each position ≈ 30 bytes across the
  // per-signal TypedArrays). For a typical Z80 workload that's seconds
  // of bus history; at full-speed continuous run it's milliseconds.
  // Both numbers are tunable per machine via the future settings UI.
  ringChunks: 16,
  chunkSize: 4096,
};

/**
 * Maximum HC range the HW-trace section renders into the DOM at once.
 * The waveform fills the body's scrollable area; the visible viewport
 * is a subset (~viewport width / cell width). Capping prevents the
 * DOM from blowing up on very long runs — older history still lives
 * in the buffer until it ages out the ring, but is invisible past
 * this cap. The gear-modal exposure of this knob lands in M8b.
 */
export const DEFAULT_HW_TRACE_RENDER_MAX_HCS = 10_000;
