// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// Z80Breakpoints — a debug helper that attaches to a Z80DebugContext
// and adds PC-range breakpoints + half-cycle-based step triggers.
//
// Owns no per-edge state of its own beyond the bp registry and the
// stepHc trigger fields. Reads HC from an external HcCounter (the
// consumer's own Float64Array slot) so multi-CPU systems can give each
// CPU its own counter.
//
// Wiring pattern (consumer's per-edge loop):
//   dbg.clockEdge();
//   hcBox[0]++;             // consumer ticks its own counter
//   bp.tickAfterEdge();     // PC scan + stepHc check
//
// PC-bp + stepHc fire are post-edge. `dbg.clockEdge()` runs the step
// queued on the CPU, then `cpu.nextStep` reflects the *upcoming* step;
// when that's an M1 entry (M1_T1_0 / NMI_M1_T1_0 / INT_M1_T1_0), PC is
// the fetch address of the M1 about to start — the natural moment to
// fire "break at address X." This is one edge earlier than the OLD
// in-dbg pre-edge scan but observes identical PC, and CPU state at the
// moment the user sees the break.

import { StepId } from "@dcorp80/z80cpu";
import type { HcCounter } from "./hc-counter.ts";
import type { Z80DebugContext } from "./z80dbg.ts";

/** Payload passed to a PC-breakpoint callback. */
export interface PcBreakInfo {
  /** PC at the M1 boundary where the breakpoint fired. */
  pc: number;
  /** The matched range — lets one cb branch on which bp fired. */
  lo: number;
  hi: number;
}

/**
 * Handle returned by `addPcBreak`. Call `remove()` to disarm. Idempotent
 * — removing the same handle twice is safe.
 */
export interface BreakHandle {
  remove(): void;
}

export class Z80Breakpoints {
  private readonly _dbg: Z80DebugContext;
  // Cached at ctor so the hot path is a direct typed-array indexed
  // load, no accessor dispatch and no intermediate object lookup.
  private readonly _hcBox: Float64Array;
  private readonly _hcIndex: number;

  constructor(dbg: Z80DebugContext, hc: HcCounter) {
    this._dbg = dbg;
    this._hcBox = hc.box;
    this._hcIndex = hc.index;
  }

  // Pending stepHc state. _stepFireHc < 0 means "no step armed".
  // _stepEnableHc < 0 means "no auto-enable pending" (either already past
  // that point, or step was armed while already enabled).
  private _stepFireHc = -1;
  private _stepEnableHc = -1;
  private _stepCb: (() => void) | null = null;

  /**
   * Arm a one-shot trigger that fires `cb` after `n` half-cycles have
   * elapsed (measured against the HcCounter passed to the ctor). To
   * guarantee the caller sees trace state at fire time, `dbg.enabled`
   * is forced true `prefetchHc` HC before the target — long enough that
   * at least one full instruction is observed even if dbg was running
   * disabled.
   *
   * `prefetchHc` defaults to 96 HC (48 T-states) — covers any single Z80
   * instruction including DDCB forms. Pass 0 to fire without any prefetch
   * window, or a larger number to guarantee multiple traces of context.
   *
   * After firing, `_stepCb` is cleared but `dbg.enabled` is NOT restored
   * — chained `stepHc` calls then start immediately. The caller manages
   * `dbg.enabled` separately if they want to drop back to free-run mode.
   *
   * Calling `stepHc` while a previous step is pending silently replaces
   * it; the old `cb` is dropped.
   */
  stepHc(n: number, cb: () => void, prefetchHc = 96): void {
    if (n < 1) throw new Error(`stepHc: n must be >= 1, got ${n}`);
    if (prefetchHc < 0)
      throw new Error(`stepHc: prefetchHc must be >= 0, got ${prefetchHc}`);
    const now = this._hcBox[this._hcIndex];
    this._stepFireHc = now + n;
    const enableAt = this._stepFireHc - prefetchHc;
    if (enableAt <= now) {
      // Prefetch window already covers "now" — enable immediately and
      // skip the per-edge enable check.
      if (!this._dbg.enabled) this._dbg.enabled = true;
      this._stepEnableHc = -1;
    } else {
      this._stepEnableHc = enableAt;
    }
    this._stepCb = cb;
  }

  /**
   * Cancel any pending `stepHc` trigger. Idempotent. Use when a caller
   * exits its tick loop via a different condition (e.g. an instruction
   * completion in `<enter>`) and doesn't want the leftover trigger to
   * fire — and, critically, to auto-enable dbg — during a subsequent
   * unrelated loop.
   */
  cancelStepHc(): void {
    this._stepCb = null;
    this._stepFireHc = -1;
    this._stepEnableHc = -1;
  }

  // Registered PC breakpoints. On each `tickAfterEdge` when `cpu.nextStep`
  // is an M1 entry (regular fetch, NMI redirect, INT ack), every entry
  // whose [lo,hi] range contains pc fires its callback. The M1-entry gate
  // gives edge-triggered semantics for free: it's reached exactly once
  // per instruction execution, so a breakpoint at X fires once per visit
  // to X regardless of how many HC PC sat at X mid-prev-instruction.
  private _pcBreaks: Array<{
    lo: number;
    hi: number;
    cb: (info: PcBreakInfo) => void;
  }> = [];

  /**
   * Register a PC breakpoint covering `[lo, hi]` (inclusive). Single-
   * address form: `addPcBreak(addr, addr, cb)`. The callback receives
   * `{pc, lo, hi}` so a shared handler can branch on which range matched.
   *
   * Fires at instruction boundary (M1 entry — regular, NMI, or INT ack).
   * If `dbg` is disabled, it is force-enabled before the callback runs
   * so the in-flight M1 is observed cleanly — the typical "stop here"
   * use case.
   *
   * Returns a handle; call `.remove()` to disarm.
   */
  addPcBreak(
    lo: number,
    hi: number,
    cb: (info: PcBreakInfo) => void,
  ): BreakHandle {
    if (lo > hi) throw new Error(`addPcBreak: lo (${lo}) > hi (${hi})`);
    const entry = { lo: lo & 0xffff, hi: hi & 0xffff, cb };
    this._pcBreaks.push(entry);
    return {
      remove: () => {
        const i = this._pcBreaks.indexOf(entry);
        if (i >= 0) this._pcBreaks.splice(i, 1);
      },
    };
  }

  /** Disarm every PC breakpoint. Idempotent. */
  clearAllPcBreaks(): void {
    this._pcBreaks.length = 0;
  }

  /** Snapshot of the currently armed PC breakpoint ranges. */
  listPcBreaks(): ReadonlyArray<{ lo: number; hi: number }> {
    return this._pcBreaks.map((b) => ({ lo: b.lo, hi: b.hi }));
  }

  /**
   * Run PC-bp scan + stepHc fire check. Consumer calls this immediately
   * after `dbg.clockEdge()` (and after ticking its own HcCounter). Both
   * are no-ops when nothing is armed.
   */
  tickAfterEdge(): void {
    const cpu = this._dbg.cpu;
    const nextStep = cpu.nextStep;

    if (
      this._pcBreaks.length > 0 &&
      (nextStep === StepId.M1_T1_0 ||
        nextStep === StepId.NMI_M1_T1_0 ||
        nextStep === StepId.INT_M1_T1_0)
    ) {
      const pc = cpu.regs.pc & 0xffff;
      const n = this._pcBreaks.length;
      for (let i = 0; i < n; i++) {
        const b = this._pcBreaks[i];
        if (pc >= b.lo && pc <= b.hi) {
          if (!this._dbg.enabled) this._dbg.enabled = true;
          b.cb({ pc, lo: b.lo, hi: b.hi });
        }
      }
    }

    if (this._stepCb !== null) {
      // Read the HC slot once into a local — direct typed-array indexed
      // access stays unboxed and is the whole point of the `{box,index}`
      // shape on HcCounter. Called per edge.
      const h = this._hcBox[this._hcIndex];
      if (this._stepEnableHc >= 0 && h >= this._stepEnableHc) {
        if (!this._dbg.enabled) this._dbg.enabled = true;
        this._stepEnableHc = -1;
      }
      if (h >= this._stepFireHc) {
        const cb = this._stepCb;
        this._stepCb = null;
        this._stepFireHc = -1;
        cb();
      }
    }
  }
}
