// Interrupts section. Hosts the INT vector byte input and the INT
// generator — a periodic nINT pulse driver (ZX Spectrum vsync, CTC-
// channel interrupts, etc.). See DESIGN §2.7 and REQ §6.8.

import type { Component } from "solid-js";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import { HexAddrInput } from "../hexAddrInput.tsx";
import type { SectionModule } from "../types.ts";

const SECTION_ID = "interrupts";

const Header: Component = () => null;

const FoldedSummary: Component = () => {
  const store = useStore();
  return (
    <span class="interrupts-folded-summary">
      {STR.interrupts.foldedSummary(
        formatHex(store.inputPins.intVector, 2),
        store.intGen().enabled,
        store.intGen().period,
        store.intGen().pulseWidth,
      )}
    </span>
  );
};

const VECTOR_INPUT_ID = "interrupts-int-vector";
const PERIOD_INPUT_ID = "interrupts-gen-period";
const PULSE_WIDTH_INPUT_ID = "interrupts-gen-pulsewidth";

/** Read a positive-integer decimal string; returns `undefined` on parse fail. */
function parsePositiveInt(s: string): number | undefined {
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

const Body: Component = () => {
  const store = useStore();
  const isPaused = () => store.isPaused();
  const genEnabled = () => store.intGen().enabled;
  const genPeriod = () => store.intGen().period;
  const genPulseWidth = () => store.intGen().pulseWidth;

  function commitPeriod(raw: string): boolean {
    const n = parsePositiveInt(raw);
    if (n === undefined || n < genPulseWidth() + 1) return false;
    store.setIntGen({ period: n });
    return true;
  }

  function commitPulseWidth(raw: string): boolean {
    const n = parsePositiveInt(raw);
    if (n === undefined || n < 1) return false;
    store.setIntGen({ pulseWidth: n });
    return true;
  }

  return (
    <div class="interrupts-body">
      <div class="interrupts-row" title={STR.interrupts.vectorTooltip}>
        <label class="interrupts-row-label" for={VECTOR_INPUT_ID}>
          {STR.interrupts.vectorLabel}
        </label>
        <HexAddrInput
          id={VECTOR_INPUT_ID}
          class="interrupts-vector-input"
          committed={() => store.inputPins.intVector}
          padTo={2}
          maxValue={0xff}
          commit={(value) => {
            store.setIntVector(value);
          }}
          ariaLabel={STR.interrupts.vectorAriaLabel}
          title={STR.interrupts.vectorTooltip}
          size={4}
          maxLength={4}
        />
      </div>

      <div class="interrupts-gen-group">
        <div class="interrupts-gen-header">
          <span class="interrupts-gen-label">{STR.interrupts.genLabel}</span>
          <label class="interrupts-gen-enabled-label">
            <input
              type="checkbox"
              class="interrupts-gen-enabled-checkbox"
              aria-label={STR.interrupts.genEnabledAriaLabel}
              title={STR.interrupts.genEnabledTooltip}
              checked={genEnabled()}
              disabled={!isPaused()}
              onChange={(e) =>
                store.setIntGen({ enabled: e.currentTarget.checked })
              }
            />
            {STR.interrupts.genEnabledLabel}
          </label>
        </div>

        <div class="interrupts-gen-fields">
          <div class="interrupts-row">
            <label class="interrupts-row-label" for={PERIOD_INPUT_ID}>
              {STR.interrupts.genPeriodLabel}
            </label>
            <input
              id={PERIOD_INPUT_ID}
              type="text"
              inputMode="numeric"
              class="interrupts-gen-decimal-input"
              aria-label={STR.interrupts.genPeriodAriaLabel}
              title={STR.interrupts.genPeriodTooltip}
              value={genPeriod()}
              disabled={!isPaused()}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const ok = commitPeriod(
                  (e.currentTarget as HTMLInputElement).value,
                );
                if (!ok) {
                  (e.currentTarget as HTMLInputElement).value = String(
                    genPeriod(),
                  );
                }
                (e.currentTarget as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                const ok = commitPeriod(e.currentTarget.value);
                if (!ok) e.currentTarget.value = String(genPeriod());
              }}
            />
            <span class="interrupts-gen-unit">{STR.interrupts.genHcUnit}</span>
          </div>

          <div class="interrupts-row">
            <label class="interrupts-row-label" for={PULSE_WIDTH_INPUT_ID}>
              {STR.interrupts.genPulseWidthLabel}
            </label>
            <input
              id={PULSE_WIDTH_INPUT_ID}
              type="text"
              inputMode="numeric"
              class="interrupts-gen-decimal-input"
              aria-label={STR.interrupts.genPulseWidthAriaLabel}
              title={STR.interrupts.genPulseWidthTooltip}
              value={genPulseWidth()}
              disabled={!isPaused()}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const ok = commitPulseWidth(
                  (e.currentTarget as HTMLInputElement).value,
                );
                if (!ok) {
                  (e.currentTarget as HTMLInputElement).value = String(
                    genPulseWidth(),
                  );
                }
                (e.currentTarget as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                const ok = commitPulseWidth(e.currentTarget.value);
                if (!ok) e.currentTarget.value = String(genPulseWidth());
              }}
            />
            <span class="interrupts-gen-unit">{STR.interrupts.genHcUnit}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export const interrupts: SectionModule = {
  id: SECTION_ID,
  title: STR.interrupts.title,
  Header,
  FoldedSummary,
  Body,
};
