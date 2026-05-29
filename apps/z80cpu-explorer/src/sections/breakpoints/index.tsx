import { createSignal } from "solid-js";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import type { SectionModule } from "../types.ts";

// Compact decimal formatter for HC + instruction counts. Thousands
// separators help legibility once the numbers get big.
const fmt = (n: number): string => n.toLocaleString("en-US");

function statusLine(
  status: "paused" | "running" | "stepping",
  hc: number,
  insns: number,
  reasonText: string,
): string {
  if (status === "running")
    return STR.breakpoints.runningStatus(fmt(hc), fmt(insns));
  if (status === "stepping")
    return STR.breakpoints.steppingStatus(fmt(hc), fmt(insns));
  return STR.breakpoints.pausedStatus(reasonText, fmt(hc), fmt(insns));
}

function reasonToText(
  r: ReturnType<typeof useStore>["lastPauseReason"],
): string {
  const reason = r();
  if (!reason) return "";
  switch (reason.kind) {
    case "user":
      return STR.breakpoints.reasonUser;
    case "step-complete":
      return STR.breakpoints.reasonStepComplete;
    case "pc-breakpoint":
      return STR.breakpoints.reasonPcBreakpoint(formatHex(reason.pc, 4));
    case "hc-target":
      return STR.breakpoints.reasonHcTarget(fmt(reason.target));
  }
}

const Header = () => {
  const store = useStore();
  const [stepN, setStepN] = createSignal("1");
  // Step / Step N / Zero HC are paused-only — clicking mid-step would
  // clobber the in-flight step counter. Only Run/Pause stays active
  // across run states (the button itself toggles its label).
  const isPaused = () => store.status() === "paused";
  const onStepN = () => {
    const n = Number.parseInt(stepN(), 10);
    if (Number.isFinite(n) && n > 0) store.stepInstructions(n);
  };
  return (
    <>
      <div class="bp-controls">
        <button
          type="button"
          onClick={() => (isPaused() ? store.run() : store.pause())}
        >
          {isPaused() ? STR.breakpoints.run : STR.breakpoints.pause}
        </button>
        <button
          type="button"
          onClick={() => store.stepInstructions(1)}
          disabled={!isPaused()}
          title={STR.breakpoints.stepTooltip}
        >
          {STR.breakpoints.step}
        </button>
        <input
          class="step-n-input"
          type="text"
          inputmode="numeric"
          value={stepN()}
          onInput={(e) => setStepN(e.currentTarget.value)}
          aria-label={STR.breakpoints.stepCountLabel}
          size={4}
        />
        <button type="button" onClick={onStepN} disabled={!isPaused()}>
          {STR.breakpoints.stepN}
        </button>
        <button
          type="button"
          onClick={() => store.zeroHC()}
          disabled={!isPaused()}
          title={STR.breakpoints.zeroHcTooltip}
        >
          {STR.breakpoints.zeroHc}
        </button>
      </div>
      <div class="bp-status">
        {statusLine(
          store.status(),
          store.hc(),
          store.insnCount(),
          reasonToText(store.lastPauseReason),
        )}
      </div>
    </>
  );
};

// Breakpoints' Header is always visible and carries the status line +
// controls (REQ §6.2). FoldedSummary is omitted so the frame skips its
// wrapper entirely — no empty flex slot when folded.
const Body = () => (
  <div class="placeholder">{STR.breakpoints.bodyPlaceholder}</div>
);

export const breakpoints: SectionModule = {
  id: "breakpoints",
  title: STR.breakpoints.title,
  Header,
  Body,
};
