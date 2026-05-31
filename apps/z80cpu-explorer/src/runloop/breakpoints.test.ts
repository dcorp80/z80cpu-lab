import { StepId, type Z80Cpu } from "@dcorp80/z80cpu";
import { describe, expect, it } from "vitest";
import type { Breakpoint } from "../store/types.ts";
import { createBreakpointEvaluator } from "./breakpoints.ts";

// Minimal fake of the CPU surface the evaluator touches (`nextStep` +
// `regs.pc`). Pure unit tests stay focused on the evaluator's own
// logic — the loop tests exercise the real CPU + dbg path.
const fake = (nextStep: number, pc: number): Z80Cpu =>
  ({ nextStep, regs: { pc } }) as unknown as Z80Cpu;

// Convenience: build BPs without ids the evaluator never reads.
const pc = (lo: number, hi: number, enabled = true): Breakpoint => ({
  id: `pc-${lo}-${hi}`,
  kind: "pc-range",
  lo,
  hi,
  enabled,
});
const hc = (target: number, enabled = true): Breakpoint => ({
  id: `hc-${target}`,
  kind: "hc-count",
  target,
  enabled,
});

describe("BreakpointEvaluator", () => {
  describe("PC-range", () => {
    it("fires on M1_T1_0 entry when PC is inside the range", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x8000, 0x80ff)]);
      const result = ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x8042), 100);
      expect(result).toEqual({
        kind: "pc-breakpoint",
        pc: 0x8042,
        lo: 0x8000,
        hi: 0x80ff,
      });
    });

    it("fires on NMI_M1_T1_0 entry", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x0066, 0x0066)]);
      expect(ev.checkAfterEdge(fake(StepId.NMI_M1_T1_0, 0x0066), 0)).toEqual({
        kind: "pc-breakpoint",
        pc: 0x0066,
        lo: 0x0066,
        hi: 0x0066,
      });
    });

    it("fires on INT_M1_T1_0 entry", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x0038, 0x0038)]);
      expect(ev.checkAfterEdge(fake(StepId.INT_M1_T1_0, 0x0038), 0)).toEqual({
        kind: "pc-breakpoint",
        pc: 0x0038,
        lo: 0x0038,
        hi: 0x0038,
      });
    });

    it("ignores mid-instruction edges (other step IDs)", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x8000, 0x80ff)]);
      // Pick any non-M1-entry step. M1_T3_1 is the trace-completion edge.
      expect(ev.checkAfterEdge(fake(StepId.M1_T3_1, 0x8042), 100)).toBeNull();
    });

    it("single-address range (lo === hi) fires only at that address", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x4000, 0x4000)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x3fff), 0)).toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x4001), 0)).toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x4000), 0)).not.toBeNull();
    });

    it("disabled PC-range BP does not fire", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x8000, 0x80ff, false)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x8042), 0)).toBeNull();
    });

    it("returns the first matching range when multiple overlap", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([pc(0x8000, 0x80ff), pc(0x8040, 0x8050)]);
      const r = ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x8045), 0);
      // First in iteration order wins. Either is a valid pause; we
      // pin down the deterministic choice so the UI stays stable.
      expect(r).toMatchObject({
        kind: "pc-breakpoint",
        pc: 0x8045,
        lo: 0x8000,
        hi: 0x80ff,
      });
    });
  });

  describe("HC-count", () => {
    it("fires when hc reaches the target", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 99)).toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100)).toEqual({
        kind: "hc-target",
        target: 100,
      });
    });

    it("is one-shot — does not refire on the next edge", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100)).not.toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 101)).toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 200)).toBeNull();
    });

    it("advances to the next-min target after a fire", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100), hc(200), hc(300)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100)).toMatchObject({
        target: 100,
      });
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 150)).toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 200)).toMatchObject({
        target: 200,
      });
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 300)).toMatchObject({
        target: 300,
      });
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 400)).toBeNull();
    });

    it("disabled HC-count BP does not fire", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100, false)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 1_000_000)).toBeNull();
    });

    it("resetHcCutoff re-arms all HC-count BPs", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100), hc(200)]);
      ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100);
      ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 200);
      // Both fired; nothing left to fire from this run pass.
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 300)).toBeNull();
      // Caller calls resetHcCutoff (zeroHC path). Counter is back at 0,
      // both targets eligible again.
      ev.resetHcCutoff();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100)).toMatchObject({
        target: 100,
      });
    });

    it("setBreakpoints with empty list disables all firing", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100), pc(0x4000, 0x4000)]);
      ev.setBreakpoints([]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x4000), 100)).toBeNull();
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0x4000), 1000)).toBeNull();
    });

    it("adding a different BP does NOT re-fire an already-fired BP", () => {
      const ev = createBreakpointEvaluator();
      // BP A at hc=100 fires.
      ev.setBreakpoints([hc(100)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100)).toMatchObject({
        target: 100,
      });
      // User keeps A and adds B at hc=150. Both are in the new list,
      // but A's id is unchanged so its fired flag survives the rebuild
      // — re-arming would surprise the user since the BP "already hit".
      ev.setBreakpoints([hc(100), hc(150)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 120)).toBeNull();
      // B fires normally.
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 150)).toMatchObject({
        target: 150,
      });
    });

    it("toggle off then on re-arms a fired BP", () => {
      const ev = createBreakpointEvaluator();
      ev.setBreakpoints([hc(100)]);
      ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100);
      // Disable: id leaves the enabled set. Fired flag is preserved but
      // can no longer fire while disabled.
      ev.setBreakpoints([hc(100, false)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 200)).toBeNull();
      // Re-enable: off → on transition clears the fired flag, so the
      // BP arms again. Since hc has already passed its target, the
      // next edge fires it (DESIGN §3.5 "no special-case path").
      ev.setBreakpoints([hc(100, true)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 200)).toMatchObject({
        target: 100,
      });
    });

    it("adding a new BP with target ≤ current hc fires on the next edge", () => {
      const ev = createBreakpointEvaluator();
      // No BPs at hc=500. Then user adds a fresh BP at 100.
      // The new id was never enabled before, so it arms with no fired
      // flag and fires on the next edge.
      ev.setBreakpoints([hc(100)]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 500)).toMatchObject({
        target: 100,
      });
    });

    it("re-adding a removed-then-recreated BP at the same target fires again", () => {
      const ev = createBreakpointEvaluator();
      // BP A fires at hc=100.
      const bpA = hc(100);
      ev.setBreakpoints([bpA]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 100)).toMatchObject({
        target: 100,
      });
      // Remove A entirely. Single-pass cleanup drops its fired flag
      // immediately — no second mutation needed.
      ev.setBreakpoints([]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 150)).toBeNull();
      // Recreate the SAME BP (same id is the strongest signal of stale
      // state; the production path generates fresh ids, but if firedHcIds
      // hadn't been cleaned the BP would silently never fire again).
      ev.setBreakpoints([bpA]);
      expect(ev.checkAfterEdge(fake(StepId.M1_T1_0, 0), 200)).toMatchObject({
        target: 100,
      });
    });
  });
});
