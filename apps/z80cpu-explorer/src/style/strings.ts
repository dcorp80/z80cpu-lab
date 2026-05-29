// Centralized user-facing strings — single source of truth for UI copy.
//
// Not full i18n (no locale switching planned for MVP). Goal is to keep
// section components free of inline literals so copy reviews touch one
// file and parameterized status lines stay readable.
//
// Functions are used for strings that take parameters; plain strings for
// constants. Group by section / surface.

export const STR = {
  app: {
    title: "z80cpu-explorer",
  },
  frame: {
    foldLabel: (folded: boolean) =>
      folded ? "Unfold section" : "Fold section",
    dragLabel: "Drag to reorder section",
    dragTooltip: "Drag to reorder",
  },
  breakpoints: {
    title: "Breakpoints",
    run: "Run",
    pause: "Pause",
    step: "Step",
    stepN: "Step N",
    zeroHc: "Zero HC",
    stepTooltip: "Step one instruction (s)",
    zeroHcTooltip: "Zero the HC counter",
    stepCountLabel: "Step count",
    bodyPlaceholder: "Breakpoint list — milestone 5.",
    runningStatus: (hc: string, insns: string) =>
      `running · HC=${hc} · ${insns} insns`,
    steppingStatus: (hc: string, insns: string) =>
      `stepping · HC=${hc} · ${insns} insns`,
    pausedStatus: (reason: string, hc: string, insns: string) =>
      `paused${reason ? ` · ${reason}` : ""} · HC=${hc} · ${insns} insns`,
    reasonUser: "by user",
    reasonStepComplete: "step done",
    reasonPcBreakpoint: (pc: string) => `BP PC=${pc}`,
    reasonHcTarget: (target: string) => `HC target ${target}`,
  },
  program: {
    title: "Program",
    foldedEmpty: "no files loaded",
    bodyPlaceholder: "Program section — milestone 3.",
  },
  cpuState: {
    title: "CPU state",
    foldedEmpty: "CPU idle",
    bodyPlaceholder: "CPU state section — milestone 4.",
  },
  memory: {
    title: "Memory",
    foldedEmpty: "64KB · no activity",
    bodyPlaceholder: "Memory section — milestone 7.",
  },
  instructionTrace: {
    title: "Instruction trace",
    foldedEmpty: "0 insns",
    bodyPlaceholder: "Instruction trace section — milestone 6.",
  },
  io: {
    title: "IO",
    foldedEmpty: "no IO activity",
    bodyPlaceholder: "IO section — milestone 7.",
  },
  hwTrace: {
    title: "Hardware trace",
    foldedEmpty: "capture: off · viewing live",
    bodyPlaceholder: "Hardware trace section — milestone 8.",
  },
};
