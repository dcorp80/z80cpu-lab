// Shipped low-level defaults — single source of truth for tunables the
// app hands to a constructor (loop, bus, ring); these
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
  /** Wallclock budget per rAF frame (ms). */
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
 * 30 Hz baseline. `flushEveryNFrames: 2` flushes on every
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
 * the config so a future `reinit()` refills from one source
 * of truth. Each byte is masked to 8 bits at the bus boundary.
 *
 * Mem, IO, and INT vector all default to `FF`.
 */
export interface BusConfig {
  /** Byte every mem cell is filled with on construction / reinit. */
  memInit: number;
  /** Byte every IO cell is filled with on construction / reinit. */
  ioInit: number;
  /** Initial INT vector byte; user can edit at runtime. */
  intVectorInit: number;
  /**
   * When true, IO is split into two 64K planes: IN cycles
   * resolve against the RD plane (user-editable, pre-loaded), OUT cycles
   * land in the WR plane (passive record). When false, a single plane
   * services both — the original behavior. Allocation is lazy: only the
   * RD plane exists when false. Switching is a destructive op routed
   * through reinit (page reload) so allocation matches the persisted
   * flag at boot.
   */
  splitIo: boolean;
}

export const DEFAULT_BUS_CONFIG: BusConfig = {
  memInit: 0xff,
  ioInit: 0xff,
  intVectorInit: 0xff,
  splitIo: true,
};

/** Type-guard for a persisted byte (0..0xFF integer). Used to validate
 *  `BusConfig`-shaped values pulled from the storage backend before they
 *  can drive bus construction. Persisted JSON can carry anything from a
 *  corrupted save or an older schema — anything that fails this check
 *  takes the `DEFAULT_BUS_CONFIG` fallback at the call site. */
export const isPersistedByte = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xff;

// ── Instruction trace ring ────────────────────────────────────────

/**
 * Capacity of the instruction-trace ring. 10k records is
 * roughly 1 MB and covers ~10 ms of full-speed execution — enough for
 * "what just happened" inspection without burdening GC. Hot-path push
 * cost is fixed regardless of cap.
 */
export const DEFAULT_INSTRUCTION_RING_CAP = 10_000;

// ── Hex grid (memory + IO sections) ───────────────────────────────
//
// 16-bit Memory + 16-bit IO use the page-pagination model:
// the body renders one full page at a time (default 16 KB; see
// PAGE_SIZE_OPTIONS) under HexGrid's virtualization, header buttons
// step the watch address between pages.
//
// The 8-bit IO view renders all 256 ports as a single
// scrollable list — no pagination (256 < smallest page in
// PAGE_SIZE_OPTIONS), no virtualization (16 rows × 16 cells is cheap).

/**
 * Visible rows in the section body (sets the scroll viewport's height).
 * Independent of `pageSize` — page is what's in the virtualized buffer,
 * this is what's on screen at once. 8-bit and 16-bit IO share the same
 * viewport (consistency requested in the page-model UI follow-up).
 * Memory keeps its 24-row baseline matching the pre-paging window
 * size.
 */
export const DEFAULT_MEMORY_VIEWPORT_ROWS = 24;
export const DEFAULT_IO_VIEWPORT_ROWS = 3;

/**
 * Allowed bytes-per-row values for the hex grids. Restricted to powers
 * of two so row-base alignment is a single mask (`addr & ~(bpr - 1)`)
 * and CSS column tracks can be enumerated as a small fixed set.
 *
 * Split by grid: Memory spans the 16-bit (64K) address space and goes up
 * to 128. The IO grid's 8-bit view renders the full 256-port space; a
 * 128-wide row would leave only 2 rows, which collapses the watch-row
 * highlight into a near-full-width band — so IO caps at 64.
 */
export const MEMORY_BYTES_PER_ROW_OPTIONS = [16, 32, 64, 128] as const;
export const IO_BYTES_PER_ROW_OPTIONS = [16, 32, 64] as const;
export type BytesPerRow = (typeof MEMORY_BYTES_PER_ROW_OPTIONS)[number];
export const DEFAULT_MEMORY_BYTES_PER_ROW: BytesPerRow = 16;
export const DEFAULT_IO_BYTES_PER_ROW: BytesPerRow = 16;

/**
 * Page size for the Memory / IO address-page pagination model
 *. The body renders one full page at a time; header buttons
 * `<<` / `< NNNN` / `NNNN >` / `>>` step `watchAddr` to the destination
 * page's base. Restricted to powers of two so `pageBase` is a single
 * mask, and to a small enumerable set so a `<select>` UI can ship the
 * full option list. Memory and IO share the same option set — both run
 * in the 16-bit address space; the IO 8-bit view hides the page-nav
 * row entirely (256 ports fits in any page).
 */
export const PAGE_SIZE_OPTIONS = [1024, 4096, 8192, 16384] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_MEMORY_PAGE_SIZE: PageSize = 4096;
export const DEFAULT_IO_PAGE_SIZE: PageSize = 1024;

// ── HW trace buffer ────────────────────────────────

/**
 * Capture is binary: `enabled: false` short-circuits `record()` (zero
 * per-edge cost); `true` retains the most recent
 * state changes.
 *
 * The buffer is a single flat ring of `capacity` per-edge snapshots —
 * no internal chunk segmentation; eviction is per-record (the oldest
 * snapshot drops on overflow). Must be a positive power of two so the
 * hot-path advance can wrap with a single `&` mask.
 */
export interface HwTraceConfig {
  enabled: boolean;
  /** Ring capacity in snapshots. Must be a power of two. */
  capacity: number;
}

export const DEFAULT_HW_TRACE_CONFIG: HwTraceConfig = {
  enabled: true,
  // ~960 KB total at 65 536 snapshots (each ≈ 15 bytes across the
  // per-signal TypedArrays). For a typical Z80 workload that's seconds
  // of bus history; at full-speed continuous run it's milliseconds.
  // Tunable per machine via the future settings UI.
  capacity: 65_536,
};
