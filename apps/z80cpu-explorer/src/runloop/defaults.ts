// Tunables for the run loop. Per DESIGN §2.4 every numeric knob the loop
// reads comes from a single config object — no magic numbers inline.

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
