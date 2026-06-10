import { StepId, type Z80Cpu } from "@dcorp80/z80cpu";
import type { Breakpoint } from "../store/types.ts";
import type { PauseReason } from "./loop.ts";

/**
 * Per-edge breakpoint evaluator. The store calls `setBreakpoints` on
 * every add/remove/toggle/edit; the loop calls `checkAfterEdge(cpu, hc)`
 * once per edge in its hot path and pauses on a non-null return.
 *
 * Cost profile (DESIGN §3.5):
 * - PC-range: gated on the three M1-entry step IDs, so the linear scan
 *   over enabled BPs only runs ~1M times/sec at full speed. Realistic
 *   N (<100) is fine without a smarter index.
 * - HC-count: checked every edge (~40M/sec). The `nextHcTarget` cache
 *   collapses it to a single number compare regardless of N.
 *
 * One-shot semantics (HC-count): each HC-count BP fires at most once
 * per run pass. We track fired BPs by id and recompute the next-min
 * target across only the not-yet-fired entries.
 *
 * - Add a new HC BP with target ≤ current hc → it fires on the next
 *   edge (DESIGN §3.5 "no special-case path").
 * - Toggle a fired BP off then on → it re-arms (the off → on
 *   transition clears its fired flag).
 * - `resetHcCutoff()` (zeroHC) clears the entire fired set.
 *
 * Why id-tracking rather than just popping the fired target on fire:
 * the store rebuilds the BP list on every mutation, so the "popped"
 * target would come back as soon as the user added a different BP.
 * Tracking by id keeps the semantic "fired BPs stay quiet until you
 * explicitly re-arm them."
 */
export interface BreakpointEvaluator {
  /** Replace the active BP set. Called by the store on every mutation. */
  setBreakpoints(bps: ReadonlyArray<Breakpoint>): void;
  /** Called once per edge from the loop hot path. */
  checkAfterEdge(cpu: Z80Cpu, hc: number): PauseReason | null;
  /** Re-arm all HC-count BPs (called from zeroHC). */
  resetHcCutoff(): void;
}

interface PcBp {
  lo: number;
  hi: number;
}

interface HcBp {
  id: string;
  target: number;
}

export function createBreakpointEvaluator(): BreakpointEvaluator {
  let enabledPc: PcBp[] = [];
  // All enabled HC-count BPs; we filter against `firedHcIds` when
  // recomputing the next-min target. Kept around so re-enable can
  // reinstate without the caller passing extra state.
  let enabledHc: HcBp[] = [];
  // Ids previously seen in `enabledHc` — used to detect off→on
  // transitions on the next `setBreakpoints` call. An id missing from
  // this set when it appears as enabled is a re-enable (or fresh add),
  // and we clear its fired flag.
  let prevEnabledHcIds: Set<string> = new Set();
  const firedHcIds: Set<string> = new Set();
  let nextHcTarget: number = Number.POSITIVE_INFINITY;

  function recomputeNextHc(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const b of enabledHc) {
      if (!firedHcIds.has(b.id) && b.target < next) next = b.target;
    }
    nextHcTarget = next;
  }

  return {
    setBreakpoints(bps) {
      enabledPc = [];
      const nextEnabledHc: HcBp[] = [];
      const nextEnabledHcIds = new Set<string>();
      // All HC-count ids in the new list, enabled or not. Used to drop
      // fired ids whose BP was removed outright (vs merely disabled —
      // disabled BPs keep their fired flag so a quick toggle off/on is
      // a deliberate user gesture).
      const nextAllHcIds = new Set<string>();
      for (const b of bps) {
        if (b.kind === "hc-count") nextAllHcIds.add(b.id);
        if (!b.enabled) continue;
        if (b.kind === "pc-range") {
          enabledPc.push({ lo: b.lo, hi: b.hi });
        } else {
          nextEnabledHc.push({ id: b.id, target: b.target });
          nextEnabledHcIds.add(b.id);
        }
      }
      // Off→on transition: any currently-enabled id that wasn't
      // enabled last time gets its fired flag cleared.
      for (const id of nextEnabledHcIds) {
        if (!prevEnabledHcIds.has(id)) firedHcIds.delete(id);
      }
      // Removed BPs: drop fired flags for ids no longer in the BP list
      // at all. Single pass — `nextAllHcIds` captures both enabled and
      // disabled BPs, so the cleanup is immediate rather than delayed
      // by one mutation.
      for (const id of firedHcIds) {
        if (!nextAllHcIds.has(id)) firedHcIds.delete(id);
      }
      enabledHc = nextEnabledHc;
      prevEnabledHcIds = nextEnabledHcIds;
      recomputeNextHc();
    },
    checkAfterEdge(cpu, hc) {
      // HC-count first: single number compare, fires on any edge. We
      // need to discover *which* BP id corresponds to `nextHcTarget`
      // so we can mark it fired — at most a handful of HC-count BPs in
      // realistic use, so the second pass is cheap (and only on the
      // rare fire-edge path, not the per-edge hot path).
      if (hc >= nextHcTarget) {
        const target = nextHcTarget;
        for (const b of enabledHc) {
          if (b.target === target && !firedHcIds.has(b.id)) {
            firedHcIds.add(b.id);
            break;
          }
        }
        recomputeNextHc();
        return { kind: "hc-target", target };
      }
      // PC-range: gated on the three M1 entries — regular fetch, NMI
      // redirect, INT acknowledge. Same three IDs dbg uses for its own
      // BP gate (DESIGN §2.6). At this edge `cpu.regs.pc` is the fetch
      // address of the M1 about to start.
      // Indexed for + property access (no destructuring): the iterator-
      // protocol path under for..of can defeat V8's optimizer on the
      // hot per-M1 scan (~10⁶/sec at full speed) and surfaces as GC
      // sawtooth in the profiler.
      const s = cpu.nextStep;
      if (
        s === StepId.M1_T1_0 ||
        s === StepId.NMI_M1_T1_0 ||
        s === StepId.INT_M1_T1_0
      ) {
        const pc = cpu.regs.pc;
        const n = enabledPc.length;
        for (let i = 0; i < n; i++) {
          const b = enabledPc[i];
          if (pc >= b.lo && pc <= b.hi) {
            return { kind: "pc-breakpoint", pc, lo: b.lo, hi: b.hi };
          }
        }
      }
      return null;
    },
    resetHcCutoff() {
      firedHcIds.clear();
      recomputeNextHc();
    },
  };
}
