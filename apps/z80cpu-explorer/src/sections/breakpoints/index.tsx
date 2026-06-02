import { createMemo, createSignal, For, Show } from "solid-js";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { filterHexInput, formatHex, parseAddr16 } from "../../util/hex.ts";
import { HexAddrInput } from "../hexAddrInput.tsx";
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
  // Two separate N inputs — instruction vs HC. Same input shared
  // between Step N and Step N HC would be confusing because the
  // typical magnitudes differ wildly (5 insns vs 5000 HC).
  const [stepN, setStepN] = createSignal("1");
  const [stepHcN, setStepHcN] = createSignal("1");
  // Step / Step N / Step HC / Step N HC / Zero HC / Reinit are
  // paused-only. Reinit reloads the page; doing that mid-run would be
  // surprising. Only Run/Pause stays active across run states.
  const isPaused = () => store.status() === "paused";
  const onStepN = () => {
    const n = Number.parseInt(stepN(), 10);
    if (Number.isFinite(n) && n > 0) store.stepInstructions(n);
  };
  const onStepHcN = () => {
    const n = Number.parseInt(stepHcN(), 10);
    if (Number.isFinite(n) && n > 0) store.stepHC(n);
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
          onClick={() => store.stepHC(1)}
          disabled={!isPaused()}
          title={STR.breakpoints.stepHcTooltip}
        >
          {STR.breakpoints.stepHc}
        </button>
        <input
          class="step-n-input"
          type="text"
          inputmode="numeric"
          value={stepHcN()}
          onInput={(e) => setStepHcN(e.currentTarget.value)}
          aria-label={STR.breakpoints.stepHcCountLabel}
          size={6}
        />
        <button
          type="button"
          onClick={onStepHcN}
          disabled={!isPaused()}
          title={STR.breakpoints.stepNHcTooltip}
        >
          {STR.breakpoints.stepNHc}
        </button>
        <button
          type="button"
          onClick={() => store.zeroHC()}
          disabled={!isPaused()}
          title={STR.breakpoints.zeroHcTooltip}
        >
          {STR.breakpoints.zeroHc}
        </button>
        <button
          type="button"
          onClick={() => {
            // TODO(REQ §7.4): surface save-or-skip modal once snapshot /
            // HW-trace buffers exist (M8c / M9). For now Reinit goes
            // straight through — there's nothing in-memory worth saving
            // at this milestone.
            window.location.reload();
          }}
          disabled={!isPaused()}
          title={STR.breakpoints.reinitTooltip}
        >
          {STR.breakpoints.reinit}
        </button>
      </div>
      <div class="bp-status">
        {statusLine(
          store.status(),
          store.hc(),
          // Throttled mirror — the raw insnCount ticks per instruction
          // (~10⁵–10⁶ Hz). Reading it here would repaint the status
          // text node hundreds of thousands of times per second; the
          // user can't read it at that rate anyway. Flushed on pause.
          store.insnCountThrottled(),
          reasonToText(store.lastPauseReason),
        )}
      </div>
    </>
  );
};

const FoldedSummary = () => {
  const store = useStore();
  const enabled = createMemo(
    () => store.breakpoints.filter((b) => b.enabled).length,
  );
  return (
    <Show
      when={store.breakpoints.length > 0}
      fallback={<span class="muted">{STR.breakpoints.foldedEmpty}</span>}
    >
      <span class="muted">
        {STR.breakpoints.foldedSummary(store.breakpoints.length, enabled())}
      </span>
    </Show>
  );
};

interface PcRowProps {
  bp: { id: string; lo: number; hi: number; enabled: boolean };
}

const PcRow = (props: PcRowProps) => {
  const store = useStore();
  // Commit returns false on cross-field violation (lo > hi) so the
  // shared HexAddrInput flashes its invalid cue and reverts.
  const commitLo = (v: number): boolean => {
    if (v === props.bp.lo) return true;
    try {
      store.editBreakpoint(props.bp.id, { lo: v });
      return true;
    } catch {
      return false;
    }
  };
  const commitHi = (v: number): boolean => {
    if (v === props.bp.hi) return true;
    try {
      store.editBreakpoint(props.bp.id, { hi: v });
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div class="bp-row" classList={{ "is-disabled": !props.bp.enabled }}>
      <input
        type="checkbox"
        checked={props.bp.enabled}
        onChange={() => store.toggleBreakpoint(props.bp.id)}
        aria-label={STR.breakpoints.bpEnabledLabel}
      />
      <span class="bp-kind">{STR.breakpoints.bpKindPc}</span>
      <HexAddrInput
        class="bp-hex-input"
        committed={() => props.bp.lo}
        commit={commitLo}
        size={5}
        ariaLabel={STR.breakpoints.bpPcLoLabel}
      />
      <span class="bp-range-sep">{STR.breakpoints.bpRangeSeparator}</span>
      <HexAddrInput
        class="bp-hex-input"
        committed={() => props.bp.hi}
        commit={commitHi}
        size={5}
        ariaLabel={STR.breakpoints.bpPcHiLabel}
      />
      <button
        type="button"
        class="bp-delete"
        onClick={() => store.removeBreakpoint(props.bp.id)}
        title={STR.breakpoints.bpDeleteTooltip}
      >
        {STR.breakpoints.bpDelete}
      </button>
    </div>
  );
};

interface HcRowProps {
  bp: { id: string; target: number; enabled: boolean };
}

// Decimal target — HC counts are big numbers humans read as decimal.
const filterDecInput = (s: string): string => s.replace(/[^0-9]/g, "");
// Clamped at Number.MAX_SAFE_INTEGER because the HC counter is itself a
// JS number (REQ §7.3). A target past safe-int could never match — reject
// at the parse boundary so the store assertion never sees one.
const parseHcTarget = (s: string): number | null => {
  const v = Number.parseInt(s.trim(), 10);
  if (!Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) return null;
  return v;
};

const HcRow = (props: HcRowProps) => {
  const store = useStore();
  const [tEdit, setTEdit] = createSignal<string | null>(null);
  const [tInvalid, setTInvalid] = createSignal(false);
  const tText = () => tEdit() ?? String(props.bp.target);
  const commitT = () => {
    const v = parseHcTarget(tText());
    if (v === null) {
      setTInvalid(true);
      return;
    }
    setTInvalid(false);
    setTEdit(null);
    if (v !== props.bp.target) {
      store.editBreakpoint(props.bp.id, { target: v });
    }
  };
  return (
    <div class="bp-row" classList={{ "is-disabled": !props.bp.enabled }}>
      <input
        type="checkbox"
        checked={props.bp.enabled}
        onChange={() => store.toggleBreakpoint(props.bp.id)}
        aria-label={STR.breakpoints.bpEnabledLabel}
      />
      <span class="bp-kind">{STR.breakpoints.bpKindHc}</span>
      <input
        class="bp-dec-input"
        classList={{ "is-invalid": tInvalid() }}
        type="text"
        inputmode="numeric"
        value={tText()}
        size={10}
        aria-label={STR.breakpoints.bpHcTargetLabel}
        onInput={(e) => {
          const filtered = filterDecInput(e.currentTarget.value);
          if (filtered !== e.currentTarget.value)
            e.currentTarget.value = filtered;
          setTEdit(filtered);
          setTInvalid(false);
        }}
        onBlur={commitT}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitT();
            (e.currentTarget as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            setTEdit(null);
            setTInvalid(false);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <button
        type="button"
        class="bp-delete"
        onClick={() => store.removeBreakpoint(props.bp.id)}
        title={STR.breakpoints.bpDeleteTooltip}
      >
        {STR.breakpoints.bpDelete}
      </button>
    </div>
  );
};

const AddStub = () => {
  const store = useStore();
  const [kind, setKind] = createSignal<"pc-range" | "hc-count">("pc-range");
  const [loStr, setLoStr] = createSignal("");
  const [hiStr, setHiStr] = createSignal("");
  const [hcStr, setHcStr] = createSignal("");
  // Per-field invalid flags — matches the in-row edit pattern so a
  // bad value in one field doesn't paint the others red. lo > hi is a
  // cross-field violation; we mark both bounds invalid in that case.
  const [loInvalid, setLoInvalid] = createSignal(false);
  const [hiInvalid, setHiInvalid] = createSignal(false);
  const [hcInvalid, setHcInvalid] = createSignal(false);

  const onAdd = () => {
    if (kind() === "pc-range") {
      const lo = parseAddr16(loStr());
      // Empty hi defaults to lo (single-address BP) — matches the
      // common workflow of "pause when PC hits this address".
      const hi = hiStr().trim() === "" ? lo : parseAddr16(hiStr());
      const loBad = lo === null;
      const hiBad = hi === null;
      const crossBad = !loBad && !hiBad && (lo as number) > (hi as number);
      setLoInvalid(loBad || crossBad);
      setHiInvalid(hiBad || crossBad);
      if (loBad || hiBad || crossBad) return;
      store.addBreakpoint({
        kind: "pc-range",
        lo: lo as number,
        hi: hi as number,
      });
      setLoStr("");
      setHiStr("");
    } else {
      const target = parseHcTarget(hcStr());
      if (target === null) {
        setHcInvalid(true);
        return;
      }
      setHcInvalid(false);
      store.addBreakpoint({ kind: "hc-count", target });
      setHcStr("");
    }
  };

  return (
    <div class="bp-row bp-add-stub">
      <select
        value={kind()}
        onChange={(e) => {
          setKind(e.currentTarget.value as "pc-range" | "hc-count");
          setLoInvalid(false);
          setHiInvalid(false);
          setHcInvalid(false);
        }}
        aria-label={STR.breakpoints.addBpKindLabel}
      >
        <option value="pc-range">{STR.breakpoints.addBpKindOptions.pc}</option>
        <option value="hc-count">{STR.breakpoints.addBpKindOptions.hc}</option>
      </select>
      <Show
        when={kind() === "pc-range"}
        fallback={
          <input
            class="bp-dec-input"
            classList={{ "is-invalid": hcInvalid() }}
            type="text"
            inputmode="numeric"
            value={hcStr()}
            size={10}
            aria-label={STR.breakpoints.bpHcTargetLabel}
            placeholder="0"
            onInput={(e) => {
              const filtered = filterDecInput(e.currentTarget.value);
              if (filtered !== e.currentTarget.value)
                e.currentTarget.value = filtered;
              setHcStr(filtered);
              setHcInvalid(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && onAdd()}
          />
        }
      >
        <input
          class="bp-hex-input"
          classList={{ "is-invalid": loInvalid() }}
          type="text"
          value={loStr()}
          size={5}
          aria-label={STR.breakpoints.bpPcLoLabel}
          placeholder="0000"
          onInput={(e) => {
            const filtered = filterHexInput(e.currentTarget.value);
            if (filtered !== e.currentTarget.value)
              e.currentTarget.value = filtered;
            setLoStr(filtered);
            setLoInvalid(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
        />
        <span class="bp-range-sep">{STR.breakpoints.bpRangeSeparator}</span>
        <input
          class="bp-hex-input"
          classList={{ "is-invalid": hiInvalid() }}
          type="text"
          value={hiStr()}
          size={5}
          aria-label={STR.breakpoints.bpPcHiLabel}
          placeholder={loStr() || "0000"}
          onInput={(e) => {
            const filtered = filterHexInput(e.currentTarget.value);
            if (filtered !== e.currentTarget.value)
              e.currentTarget.value = filtered;
            setHiStr(filtered);
            setHiInvalid(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
        />
      </Show>
      <button
        type="button"
        onClick={onAdd}
        title={STR.breakpoints.addBpTooltip}
      >
        {STR.breakpoints.addBp}
      </button>
    </div>
  );
};

const Body = () => {
  const store = useStore();
  return (
    <div class="bp-list">
      <For each={store.breakpoints}>
        {(bp) =>
          // `bp.kind` is immutable per BreakpointPatch contract (a kind
          // change would be delete + add of a different BP). The row
          // component is therefore stable for a given BP id and we
          // don't need a Switch-on-kind that remounts on kind change.
          bp.kind === "pc-range" ? <PcRow bp={bp} /> : <HcRow bp={bp} />
        }
      </For>
      <AddStub />
    </div>
  );
};

export const breakpoints: SectionModule = {
  id: "breakpoints",
  title: STR.breakpoints.title,
  Header,
  FoldedSummary,
  Body,
};
