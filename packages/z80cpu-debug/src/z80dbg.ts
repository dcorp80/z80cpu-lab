// SPDX-License-Identifier: MIT
// Copyright 2026 dcorp80

// Z80 debug context — instruction tracing via T-phase step hooks.
// Wraps Z80Cpu without modifying it. No allocations in the hot path.
//
// Pure trace observer: no breakpoint or HC concerns live here. PC-range
// breakpoints, stepHc triggers, and the half-cycle counter are owned by
// `Z80Breakpoints` (a sibling helper) + an external `HcCounter` the
// consumer ticks itself.
//
// Capture model: each clockEdge inspects cpu.nextStep (the upcoming step's
// StepId) and dispatches in a single switch:
//   M1_T1_0     — overwrite `curr.nextPc` with cpu.regs.pc, the fetch
//                 address of the M1 about to start. This is "where the
//                 just-completing instruction ended" (curr is still the
//                 in-flight trace at this point — promotion to prev
//                 happens at the following M1_T3_0). NMI_M1_T1_0 /
//                 INT_M1_T1_0 are handled the same way so the
//                 interrupted instruction's nextPc is preserved.
//   M1_T3_0     — fresh trace, capture opcode; seed curr.nextPc to
//                 startAddr (overwritten at the *next* M1_T1_0 above) so
//                 mid-instruction readers of `curr.nextPc` always see a
//                 sensible address. While seq.hasMoreMCycles (a chained
//                 prefix/CB/ED form) append to curr instead.
//   OP_RD_T1_0  — arm operand capture.
//   RD_T3_1     — if armed, capture operand byte from cpu.bus.data.
//   INT_M1_T3_0 — fresh trace, m1Type='int', capture vector.
//   NMI_M1_T3_0 — fresh trace, m1Type='nmi' (refresh-fetch byte is captured
//                 too — consumers filter by m1Type).
//   M1_T3_1     — previous instruction's deferred F-write has just landed;
//                 fire onInstructionComplete if the prev trace carries any
//                 captured bytes (length > 0).

import { type CpuState, StepId, type Z80Cpu } from "@dcorp80/z80cpu";

// Re-export the architectural-state types and decoder so consumers that
// already depend on z80cpu-debug don't need a second import line.
export { type CpuState, type DecodedFlags, decodeFlags } from "@dcorp80/z80cpu";

export type M1Type = "normal" | "nmi" | "int" | "halt" | "special_reset";

export class InstructionTrace {
  startAddr = 0;
  readonly bytes = new Array(4); // prefixes + opcode + operands; longest
  //   real Z80 instruction is 4 bytes (DDCB d op, DD 36 d n, ED nn nn,
  //   DD 21 nn nn). DD/FD followed by another prefix is split into
  //   separate traces by the wasted-prefix logic below, so no 5+ byte
  //   sequence reaches this buffer.
  length = 0;
  m1Type: M1Type = "normal";
  /**
   * Half-cycles elapsed from this trace's M1 T3 entry through the next
   * instruction's M1 T3 falling (the finalization point). Every Z80
   * cycle is 2 HC, so T-states = `hc >> 1` — divide if you want the
   * conventional T-count.
   */
  hc = 0;
  /**
   * Logical "where the CPU went next" — the fetch address of the M1
   * that follows this instruction.
   *
   * Lifecycle on `dbg.curr` (in-flight reads, for callers that bypass
   * the `onInstructionComplete` callback):
   *  - Seeded by `_initFreshCurr` at this trace's own M1 T3_0 to
   *    `startAddr` (the M1 fetch address). Stays at `startAddr` for
   *    the duration of this instruction's M-cycles — a sensible
   *    "we haven't gone anywhere yet" default for UIs that read
   *    curr mid-instruction.
   *  - Overwritten at the **next** M1's T1_0 with the live
   *    `cpu.regs.pc` (captured before T1_1 increments it), so
   *    jumps / calls / rets / NMI / INT land here as the actual
   *    next-instruction fetch address. By M1_T3_0 of that next M1
   *    this trace is promoted to `prev`, and the value is the final
   *    one delivered to the callback.
   *
   * Distinct from a snapshot's `pc`: the trace callback fires after
   * the next M1's T1_1 has incremented PC, so `state().pc` reads
   * `nextPc + 1` for the just-completed instruction. nextPc is the
   * value programmers usually mean by "PC after this instruction."
   */
  nextPc = 0;

  reset(): void {
    this.startAddr = 0;
    this.length = 0;
    this.m1Type = "normal";
    this.hc = 0;
    this.nextPc = 0;
  }
}

export class Z80DebugContext {
  readonly cpu: Z80Cpu;

  // Double-buffered traces — pre-allocated, swapped by reference
  private _a = new InstructionTrace();
  private _b = new InstructionTrace();

  /** Current instruction being fetched/executed. */
  curr: InstructionTrace = this._a;
  /** Previous instruction, in commit phase (deferred writes landing). */
  prev: InstructionTrace = this._b;

  // Tracks which read M-cycle is currently in flight: opRd contributes
  // encoding bytes to the trace (operands), mRd/ioRd do not. Set at
  // opRd_t1_0 and consumed at rd_t3_1.
  private _inOpRd = false;

  // True while we're inside a multi-M-cycle instruction (prefix chain or
  // any opcode that set seq.hasMoreMCycles). Latched from
  // cpu.seq.hasMoreMCycles at m1_t3_1 of each M1 and consumed at the
  // following m1_t3_0 to decide chain-extend vs fresh trace.
  private _multicycle = false;

  /** Fires after deferred writes have landed (M1 T3 falling of the next instruction). */
  onInstructionComplete: (trace: InstructionTrace) => void = () => {};

  private _enabled = true;

  /**
   * When false, `clockEdge` skips trace bookkeeping (curr/prev mutation,
   * byte capture, `onInstructionComplete` fires) but still ticks the CPU.
   *
   * Toggling false → true discards any partial in-flight trace state. The
   * instruction in flight at the moment of disable is silently dropped; the
   * next m1_t3_0 hook starts a clean trace.
   */
  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    if (v && !this._enabled) {
      this.prev.reset();
      this.curr.reset();
      this._inOpRd = false;
      this._multicycle = false;
    }
    this._enabled = v;
  }

  constructor(cpu: Z80Cpu) {
    this.cpu = cpu;
  }

  /**
   * Pass-through to {@link Z80Cpu.snapshot}. Kept on the debug context
   * for ergonomics — most callers already hold a `Z80DebugContext`.
   * The `halted` field is intentionally omitted from `CpuState`:
   * `trace.m1Type === 'halt'` carries that information per-instruction.
   */
  state(out?: CpuState): CpuState {
    return this.cpu.snapshot(out);
  }

  clockEdge(): void {
    const cpu = this.cpu;
    const nextStep = cpu.nextStep;

    if (this._enabled) {
      switch (nextStep) {
        case StepId.M1_T1_0:
        case StepId.NMI_M1_T1_0:
        case StepId.INT_M1_T1_0:
          // PC at any t1_0 = fetch address of the M1 about to
          // start, i.e. where the in-flight instruction "ends."
          // Recorded on curr; by the time curr is promoted to
          // prev at m1_t3_0, prev.nextPc holds the logical
          // next-PC for the callback to expose.
          this.curr.nextPc = cpu.regs.pc;
          break;
        case StepId.M1_T3_0: {
          // While inside a multi-M-cycle instruction the next M1 is
          // either a chain continuation (DD/FD/ED → another byte)
          // or — for DD/FD followed by another prefix — a wasted
          // prefix that terminates the current trace. The latter
          // falls through to a fresh trace.
          if (this._multicycle && this.curr.length > 0) {
            const b = cpu.bus.data;
            const prevByte = this.curr.length === 1 ? this.curr.bytes[0] : -1;
            // CB is a chain-extender like DD/FD/ED: its opcode
            // byte is fetched via a second M1 (not opRd), so the
            // m1_t3_0 we're looking at is the CB-prefixed opcode
            // that belongs to the same trace.
            const currIsPfxChain =
              prevByte === 0xdd ||
              prevByte === 0xfd ||
              prevByte === 0xed ||
              prevByte === 0xcb;
            // Wasted-prefix split: an existing DD/FD followed by another
            // prefix byte means the chip's prefix latch is being overwritten.
            // CB is excluded from `b` — DDCB/FDCB are real compound encodings.
            const split =
              (prevByte === 0xdd || prevByte === 0xfd) &&
              (b === 0xdd || b === 0xfd || b === 0xed);
            if (!split && currIsPfxChain && this.curr.length < 4) {
              this.curr.bytes[this.curr.length++] = b;
              break;
            }
          }
          this._initFreshCurr();
          break;
        }
        case StepId.OP_RD_T1_0:
          this._inOpRd = true;
          break;
        case StepId.RD_T3_1:
          if (this._inOpRd && this.curr.length > 0 && this.curr.length < 4) {
            this.curr.bytes[this.curr.length++] = cpu.bus.data;
            this._inOpRd = false;
          }
          break;
        case StepId.INT_M1_T3_0:
          this._initFreshCurr("int");
          break;
        case StepId.NMI_M1_T3_0:
          this._initFreshCurr("nmi");
          break;
        case StepId.M1_T3_1:
          this._multicycle = cpu.seq.hasMoreMCycles;
          // Skip the initial garbage buffer (length=0) and any
          // buffer flushed by an enabled→disabled→enabled cycle.
          // Every real trace goes through _initFreshCurr, which
          // always sets length=1.
          if (this.prev.length > 0) {
            this.onInstructionComplete(this.prev);
            this.prev.length = 0;
          }
      }
    }

    cpu.clockEdge();
    if (this._enabled) this.curr.hc++;
  }

  /**
   * Promote curr to prev, seed a fresh curr from the M1 we're entering.
   * Called at m1_t3_0 / intM1_t3_0 / nmiM1_t3_0 — by then cpu.bus has the
   * fetched byte and cpu.bus.addr still points at the instruction's PC.
   *
   * Seeds `nextPc = startAddr` so callers reading `dbg.curr` mid-instruction
   * (e.g. visual debuggers wanting a stable "preview origin") always
   * see a meaningful address. The real next-PC overwrites this at the
   * following M1's T1_0; by the time the trace fires through
   * `onInstructionComplete`, nextPc is the actual next-M1 fetch
   * address — see {@link InstructionTrace.nextPc}.
   */
  private _initFreshCurr(m1Type?: M1Type): void {
    this.prev = this.curr;
    const fresh = this.curr === this._a ? this._b : this._a;
    fresh.reset();
    fresh.startAddr = this.cpu.bus.addr;
    fresh.nextPc = this.cpu.bus.addr;
    if (this.cpu.ctl.sres) fresh.m1Type = "special_reset";
    else if (m1Type) fresh.m1Type = m1Type;
    else if (this.cpu.ctl.haltLatch) fresh.m1Type = "halt";
    fresh.bytes[0] = this.cpu.bus.data;
    fresh.length = 1;
    this.curr = fresh;
  }
}
