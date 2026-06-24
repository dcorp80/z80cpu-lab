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
  theme: {
    label: "Theme",
    optionLight: "Light",
    optionDark: "Dark",
    optionSystem: "System",
    tooltipLight: "Force light theme",
    tooltipDark: "Force dark theme",
    tooltipSystem: "Follow OS appearance (live)",
  },
  frame: {
    foldLabel: (folded: boolean) =>
      folded ? "Unfold section" : "Fold section",
    foldLockedTooltip:
      "Unsaved changes — Save or Discard them before collapsing",
    dragLabel: "Drag to reorder section",
    dragTooltip: "Drag to reorder",
  },
  appShell: {
    // Header is the app name itself — pulled from STR.app.title
    // so the name lives in exactly one place.
    version: (v: string, sha: string) => `v${v} (${sha})`,
    versionTooltip: (v: string, sha: string) => `Version ${v} · commit ${sha}`,
    coldBoot: "Cold boot",
    coldBootTooltip:
      "Reload the page — fresh CPU, mem, IO; files / breakpoints / layout survive; autoload re-fires (Shift+R)",
    memInitLabel: "Memory fill",
    memInitAriaLabel: "Memory fill byte",
    memInitTooltip:
      "Byte every memory cell is filled with on cold boot (hex 00–FF). Saving reloads the page.",
    ioInitLabel: "IO fill",
    ioInitAriaLabel: "IO fill byte",
    ioInitTooltip:
      "Byte every IO cell is filled with on cold boot (hex 00–FF). Saving reloads the page.",
    splitLabel: "Split IO RD/WR",
    splitAriaLabel: "Split IO read/write spaces",
    splitTooltip:
      "Split IO into two 64K planes: CPU IN reads RD (user-editable), CPU OUT lands in WR (read-only). Saving reloads the page.",
    save: "Save",
    saveTooltip:
      "Persist changes and Cold boot — required for the bus to re-allocate / refill",
    discard: "Discard",
    discardTooltip: "Revert to the values currently in effect",
    // Page-size selectors — UI-only, applied immediately on change
    // (no Save/Discard staging, no fold-lock contribution). Hosted
    // here because both sections share the same control set; per-
    // section was visually noisy.
    memPageLabel: "Memory page",
    memPageAriaLabel: "Memory section page size",
    memPageTooltip:
      "Page size for the Memory section's body grid. Applied immediately.",
    ioPageLabel: "IO page",
    ioPageAriaLabel: "IO section page size",
    ioPageTooltip:
      "Page size for the IO section's body grid (16-bit view only). Applied immediately.",
    // Trace-instructions toggle — drives `dbg.enabled`. Sits in the live
    // pane (non-destructive, paused-only). Off skips all per-edge dbg
    // bookkeeping for max throughput; the instruction-trace section's
    // step controls, Current row, Preview, and Capture all gate on this.
    traceInstructionsLabel: "Trace instructions",
    traceInstructionsAriaLabel: "Trace each instruction (drives dbg observer)",
    traceInstructionsTooltip:
      "Observe the CPU at every instruction boundary. Required for step-by-instruction, the Current row, the Preview, and instruction capture. Turn off for maximum run throughput when you only need PC/HC breakpoints and free-running execution.",
    collapseRepeatsLabel: "Collapse repeats",
    collapseRepeatsAriaLabel:
      "Collapse consecutive identical-PC instructions into one row",
    collapseRepeatsTooltip:
      "Fold consecutive identical-PC instructions (LDIR, HALT, JR $) into one row with an ×N badge. Disabling drops the captured ring.",
  },
  breakpoints: {
    title: "Breakpoints",
    run: "Run",
    pause: "Pause",
    runTooltip: "Resume execution (Space)",
    pauseTooltip: "Pause execution (Space)",
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
    // Effective clock-speed indicator. Host throughput as an
    // emulated Z80 clock; fixed MHz, 1 decimal. Em-dash before the first
    // run / after zeroHC.
    clock: (mhz: string) => `${mhz} MHz`,
    clockIdle: "—",
    clockTooltip:
      "Effective emulated clock — host T-state throughput at run speed",
    // Body — list rows + add stub
    foldedEmpty: "no breakpoints",
    foldedSummary: (total: number, enabled: number) =>
      `${total} ${total === 1 ? "BP" : "BPs"} · ${enabled} enabled`,
    bpEnabledLabel: "Breakpoint enabled",
    bpKindPc: "PC",
    bpKindHc: "HC",
    bpPcLoLabel: "PC range start",
    bpPcHiLabel: "PC range end",
    bpHcTargetLabel: "HC target",
    bpDelete: "Delete",
    bpDeleteTooltip: "Remove this breakpoint",
    bpRangeSeparator: "–",
    addBp: "Add",
    addBpTooltip: "Add a breakpoint with these values",
    addBpKindLabel: "Breakpoint kind",
    addBpKindOptions: { pc: "PC range", hc: "HC count" },
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
    fileNameLabel: "File name",
    fileAddrLabel: "Load address (hex)",
    fileAutoloadLabel: "Autoload",
    fileLoadButton: "Load",
    fileDeleteButton: "Delete",
    fileLoadTooltip: "Write this file at its load address",
    fileDeleteTooltip: "Remove this file",
    fileDirtyTooltip:
      "Address changed since last load — click Load to re-write",
    fileTruncatedTooltip: (n: number) => `Truncated — ${n} bytes past FFFF`,
  },
  interrupts: {
    title: "Interrupts",
    // Folded summary: "INT vector FF" normally; adds "· gen PERIOD/PW HC" when
    // the INT generator is enabled so the user can verify generator state
    // without unfolding.
    foldedSummary: (
      vector: string,
      genEnabled?: boolean,
      period?: number,
      pulseWidth?: number,
    ) =>
      genEnabled && period !== undefined && pulseWidth !== undefined
        ? `INT vector ${vector} · gen ${period}/${pulseWidth} HC`
        : `INT vector ${vector}`,
    vectorLabel: "INT vector:",
    vectorAriaLabel:
      "Interrupt vector byte (placed on cpu.bus.data during INT acknowledge)",
    vectorTooltip:
      "Hex byte placed on cpu.bus.data during INT-acknowledge cycles (nM1 low + nIORQ low). Default FF.",
    // INT generator strings
    genLabel: "INT generator",
    genEnabledLabel: "enabled",
    genEnabledAriaLabel: "Enable INT generator",
    genEnabledTooltip:
      "Drive nINT automatically on a periodic schedule. Period and pulse width are in half-cycles (HC). Enabled state persists across reloads.",
    genPeriodLabel: "period",
    genPeriodAriaLabel: "INT generator period in HC",
    genPeriodTooltip:
      "Full cycle length in HC (nINT low + nINT high). Minimum pulseWidth + 1. 50 Hz @ 3.5 MHz ≈ 139776 HC.",
    genPulseWidthLabel: "pulse width",
    genPulseWidthAriaLabel: "INT generator pulse width in HC",
    genPulseWidthTooltip:
      "How long nINT stays low (asserted) per cycle, in HC. Minimum 1. 32 T-states ≈ 64 HC.",
    genNIntDisabledTooltip:
      "Driven by INT generator — disable the generator to control nINT manually.",
    genHcUnit: "HC",
  },
  cpuState: {
    title: "CPU state",
    foldedEmpty: "CPU idle",
    flagsLabel: "Flags",
    // Bit labels for `F`. Order matches MSB→LSB (S Z Y5 H X3 P/V N C),
    // Style mod will let users override these in M11.
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
    // Folded summary: "64KB · watch=4020 · last write 4022=A7 · last read 0042".
    // Clauses drop when their data is absent so the line reads cleanly
    // on fresh boot.
    foldedHeader: (watch: string) => `64KB · watch=${watch}`,
    foldedLastWrite: (addr: string, value: string) =>
      `last write ${addr}=${value}`,
    foldedLastRead: (addr: string) => `last read ${addr}`,
    foldedNoActivity: "no activity",
    watchLabel: "Watch:",
    watchTooltip: "Hex address to watch — press Enter to jump back to this row",
    watchAriaLabel: "Memory watch address",
    recallTooltip: "Recall — jump back to the watched address",
    recallAriaLabel: "Recall memory watch address",
    showBytesLabel: "Hex",
    showBytesAriaLabel: "Show hex bytes column",
    showAsciiLabel: "ASCII",
    showAsciiAriaLabel: "Show ASCII column",
  },
  instructionTrace: {
    title: "Instruction trace",
    foldedEmpty: "0 insns",
    // Folded summary:
    //   "PC=8000 · paused · 124 insns · capture: ring · last: LD A,B"
    // The last-insn clause is dropped when the ring is empty so the
    // line reads cleanly on a fresh boot and when capture is off (which
    // implies the ring is empty — disabling capture clears it). The
    // capture clause mirrors the HW-trace folded summary so a folded
    // section surfaces capture state without unfolding.
    foldedSummary: (
      pc: string,
      status: string,
      insns: string,
      capture: boolean,
    ) =>
      `PC=${pc} · ${status} · ${insns} insns · capture: ${capture ? "ring" : "off"}`,
    foldedSummaryWithLast: (
      pc: string,
      status: string,
      insns: string,
      capture: boolean,
      lastDisasm: string,
    ) =>
      `PC=${pc} · ${status} · ${insns} insns · capture: ${capture ? "ring" : "off"} · last: ${lastDisasm}`,
    statusPaused: "paused",
    statusRunning: "running",
    statusStepping: "stepping",
    snapToLive: "Snap to live",
    snapToLiveTooltip: "Re-attach the cursor to live execution (g)",
    detachedBadge: "detached",
    detachedBadgeTooltip: (anchor: string) =>
      `Pinned at HC=${anchor} — scroll back to history`,
    // Step controls — moved from the Breakpoints header.
    step: "Step",
    stepN: "Step N",
    stepTooltip: "Step one instruction (s)",
    stepNTooltip: "Step the number of instructions in the field",
    stepCountLabel: "Step count",
    executedHeading: "Executed",
    // Tiny pane between Executed and Preview, shown only when the loop
    // paused mid-instruction (not at an M1_T3_1 boundary). Renders the
    // in-flight instruction from `dbg.curr` — captured bytes so far +
    // best-effort disasm. Hidden at boundary because the just-promoted
    // `curr` aliases the first preview row in that case.
    currentHeading: "Current",
    previewHeading: "Preview (next at PC)",
    previewEmpty: "(no bytes at PC)",
    // Shown in place of Current / Preview when "Trace instructions" (in
    // the topmost section's live-pane) is off — dbg.curr is then stale.
    previewTrackingOff: "(tracing off — no instruction position)",
    previewAddrAddBpTooltip: "Click to set a PC breakpoint here",
    previewAddrRemoveBpTooltip: "Click to remove the PC breakpoint here",
    emptyExecuted: "(no instructions executed yet)",
    // Capture toggle — mirrors the HW-trace checkbox. Unchecking
    // stops the per-instruction ring push and discards the captured ring.
    captureToggleLabel: "Capture",
    captureToggleAriaLabel: "Enable instruction trace capture",
    captureToggleTooltip:
      "Capture completed instructions into the ring. Unchecking stops capture and discards the captured ring.",
    // Shown in place of the executed rows when capture is OFF. Mirrors
    // the HW-trace bodyDisabled string so the two sections read alike.
    executedDisabled:
      "(capture off — enable Capture to record completed instructions)",
    // Column labels — used as aria-labels for screen-reader rows.
    colHc: "HC",
    colAddr: "Address",
    colBytes: "Bytes",
    colDisasm: "Disassembly",
    // m1Type tags. "normal" never renders (the common case).
    m1Tags: {
      nmi: "NMI",
      int: "INT",
      halt: "HALT",
      special_reset: "RESET",
      // Synthetic — set by the section when length===1 and bytes[0] ∈ {DD,FD}
      // (wasted prefix M1s surface as their own short traces).
      prefix: "PREFIX",
    },
    // ×N badge shown on a folded record when count > 1.
    repeatBadge: (n: number) => `×${n}`,
  },
  io: {
    title: "IO",
    foldedHeader: (watch: string) => `64K ports · watch=${watch}`,
    foldedHeader8b: (watch: string) => `256 ports · 8-bit · watch=${watch}`,
    foldedHeaderSplit: (watchRd: string, watchWr: string) =>
      `64K ports · split · RD=${watchRd} · WR=${watchWr}`,
    foldedHeaderSplit8b: (watchRd: string, watchWr: string) =>
      `256 ports · 8-bit split · RD=${watchRd} · WR=${watchWr}`,
    foldedLastOut: (addr: string, value: string) => `last out ${addr}=${value}`,
    foldedLastIn: (addr: string, value: string) => `last in ${addr}=${value}`,
    foldedNoActivity: "no activity",
    watchLabel: "Watch:",
    watchTooltip: "Hex port to watch — press Enter to jump back to this row",
    watchAriaLabel: "IO watch address",
    watchLabelRd: "RD watch:",
    watchAriaLabelRd: "IO RD-plane watch address",
    watchLabelWr: "WR watch:",
    watchAriaLabelWr: "IO WR-plane watch address",
    recallTooltip: "Recall — jump back to the watched address",
    recallAriaLabel: "Recall IO watch address",
    recallAriaLabelRd: "Recall IO RD-plane watch address",
    recallAriaLabelWr: "Recall IO WR-plane watch address",
    paneTitleRd: "RD (CPU IN, user-editable)",
    paneTitleWr: "WR (CPU OUT, read-only)",
    viewModeLabel: "Decode:",
    viewModeAriaLabel: "IO address decoding mode",
    viewMode16b: "16-bit",
    viewMode8b: "8-bit",
    viewModeTooltip:
      "16-bit: full 64K port view. 8-bit: 256 ports, edits broadcast to all upper-byte aliases.",
    aliasMismatchTooltip: (port: string) =>
      `Port ${port}: high-byte aliases hold different values; cell shows io[00${port}]. Editing rewrites all 256 aliases.`,
    aliasMismatchTooltipReadOnly: (port: string) =>
      `Port ${port}: high-byte aliases hold different values; cell shows io[00${port}].`,
  },
  hexGrid: {
    cellEditAriaLabel: (addr: string) => `Edit byte at ${addr}`,
    cellAsciiEditAriaLabel: (addr: string) => `Edit ASCII character at ${addr}`,
    // Non-printable byte glyph in the ASCII column.
    nonPrintable: ".",
    bytesPerRowLabel: "Width:",
    bytesPerRowAriaLabel: "Bytes per row",
  },
  // Memory / IO page-nav row. Strings centralized here so a
  // future restyle (e.g. ⏮ ⏪ ⏩ ⏭ glyphs) is one file's change.
  pageNav: {
    first: "<<",
    firstTooltip: "Jump to page 0",
    prev: (base: string) => `< ${base}`,
    prevTooltip: "Previous page",
    next: (base: string) => `${base} >`,
    nextTooltip: "Next page",
    last: ">>",
    lastTooltip: "Jump to last page",
    ariaLabel: "Page navigation",
    // Used by both the section page-nav row and the App-shell page-size
    // selects to format option labels ("1 KB", "16 KB", ...).
    pageSizeOption: (n: number) => `${n / 1024} KB`,
  },
  hwTrace: {
    title: "Hardware trace",
    // Glyph table. Lives in strings.ts (and not the section
    // component) so any later restyle is a single-file change. See
    // feedback-hw-trace-glyphs in memory for the rationale.
    //
    // WIDTH INVARIANT: every glyph here MUST advance exactly one
    // monospace cell (1ch), because rows are rendered as a single joined
    // string with one glyph per HC — there is no per-cell box to force
    // alignment. The original rails used the "technical" scan-lines
    // ⎺/⎽ (U+23BA/U+23BD), which several monospace fonts render at LESS
    // than a full cell; over a few hundred HCs the bus rows (hex digits,
    // always 1ch) drifted ahead of the oscilloscope rows by a whole
    // cell. Block elements and box-drawing chars are guaranteed
    // full-cell-width in any TUI-capable monospace font, so they hold
    // the invariant — and, being edge-to-edge, render HIGH/LOW spans as
    // continuous lines (paired with letter-spacing:0 on .hwt-row-waveform).
    // hwTrace.browser.test.tsx asserts equal advance width as a guard.
    glyphs: {
      high: "▔", // ▔  U+2594 UPPER ONE EIGHTH BLOCK — full-cell top rail
      low: "▁", // ▁  U+2581 LOWER ONE EIGHTH BLOCK — full-cell bottom rail
      tristate: "┈", // ┈  BOX DRAWINGS LIGHT QUADRUPLE DASH HORIZONTAL
      busHoldFiller: "·", // ·  MIDDLE DOT — bus value held until next change
    },
    // Folded summary example:
    //   "last HC: 124 M1↓ addr=0042 · capture: ring · viewing live"
    // We elide the last-edge clause when the buffer is empty so a fresh
    // boot reads cleanly. `viewingState` is "live" or "HC=NNNN" when
    // detached.
    foldedSummaryEmpty: (capture: boolean, viewing: string) =>
      `capture: ${capture ? "ring" : "off"} · viewing ${viewing}`,
    foldedSummaryWithLast: (
      lastHc: string,
      capture: boolean,
      viewing: string,
    ) =>
      `last HC: ${lastHc} · capture: ${capture ? "ring" : "off"} · viewing ${viewing}`,
    // Capture is a single enable checkbox: checked ⇒ ring capture,
    // unchecked ⇒ off. Unchecking discards the ring (a save/export
    // prompt lands in M8c), so the tooltip warns about the clear.
    captureToggleLabel: "Capture",
    captureToggleAriaLabel: "Enable HW-trace capture",
    captureToggleTooltip:
      "Capture bus activity into the ring. Unchecking stops capture and discards the captured ring.",
    viewingLive: "live",
    viewingDetached: (anchor: string) => `HC=${anchor}`,
    snapToLive: "Snap to live",
    snapToLiveTooltip: "Re-attach the HW-trace cursor to live (g)",
    detachedBadge: "detached",
    detachedBadgeTooltip: (anchor: string) =>
      `Pinned at HC=${anchor} — scroll back to history`,
    // Step / Zero HC controls — moved from the Breakpoints header
    //. Zero HC's save-or-skip modal still pending.
    stepHc: "Step HC",
    stepNHc: "Step N HC",
    zeroHc: "Zero HC",
    stepHcTooltip: "Step one half-cycle (Shift+S)",
    stepNHcTooltip: "Step N half-cycles",
    zeroHcTooltip: "Zero the HC counter (Shift+Z)",
    stepHcCountLabel: "Half-cycle step count",
    // Shown instead of a "no data yet" hint when capture is OFF and nothing is in the
    // buffer — distinguishes "intentionally not recording" from "running
    // but nothing yet," so an empty pane in disabled mode reads as expected
    // rather than broken. Disabling capture clears the ring (see
    // setHwTraceCapture), so in practice a disabled pane always lands here.
    bodyDisabled: "(capture off — enable Capture to record bus activity)",
    // Input-pin row checkbox (M8b). Left-header control on
    // each input signal row. Checked = signal asserted (level 0, active
    // low). nNMI is special — see [[feedback-nmi-pulse-semantics]].
    inputPinAriaLabel: (signal: string) => `Assert ${signal}`,
    inputPinTooltip: (signal: string) =>
      signal === "nNMI"
        ? "Check to fire NMI on the next clock edge (1-HC pulse). Auto-clears."
        : `Check to assert ${signal} (active-low). Stays asserted until unchecked.`,
    // Per-signal row labels — the left header column. Keep short so the
    // fixed-width column stays narrow. Tooltip-only for the long name.
    signalLabels: {
      nM1: "nM1",
      nMREQ: "nMREQ",
      nIORQ: "nIORQ",
      nRD: "nRD",
      nWR: "nWR",
      nRFSH: "nRFSH",
      nHALT: "nHALT",
      nBUSACK: "nBUSACK",
      nINT: "nINT",
      nNMI: "nNMI",
      nRESET: "nRESET",
      nBUSRQ: "nBUSRQ",
      nWAIT: "nWAIT",
      addr: "addr",
      data: "data",
    },
  },
};
