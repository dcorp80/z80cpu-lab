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
    foldedSummary: (count: number, headline: string) =>
      `${count} ${count === 1 ? "file" : "files"} · ${headline}`,
    foldedSummaryCount: (count: number) =>
      `${count} ${count === 1 ? "file" : "files"} loaded`,
    addFile: "Add",
    addFileTooltip: "Pick a file and write it at the address shown",
    reloadAll: "Reload all",
    reloadAllTooltip: "Re-write every file at its load address",
    reinit: "Reinit",
    reinitTooltip:
      "Reload the page — fresh CPU, mem, IO; files and layout survive, autoload re-fires",
    fileNameLabel: "File name",
    fileAddrLabel: "Load address (hex)",
    fileAutoloadLabel: "Autoload",
    fileLoadButton: "Load",
    fileDeleteButton: "Delete",
    fileLoadTooltip: "Write this file at its load address",
    fileDeleteTooltip: "Remove this file",
    fileDirtyTooltip:
      "Address changed since last load — click Load to re-write",
    fileTruncatedTooltip: (n: number) =>
      `Truncated — ${n} bytes past FFFF`,
  },
  cpuState: {
    title: "CPU state",
    foldedEmpty: "CPU idle",
    flagsLabel: "Flags",
    // Bit labels for `F`. Order matches MSB→LSB (S Z Y5 H X3 P/V N C),
    // per REQ §6.5. Style mod will let users override these in M11.
    flagBits: ["S", "Z", "Y5", "H", "X3", "P/V", "N", "C"] as const,
    iff1: "IFF1",
    iff2: "IFF2",
    im: "IM",
    shadowMark: "'",
    midInstructionTitle:
      "Mid-instruction — values are transitional; highlights paused",
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
