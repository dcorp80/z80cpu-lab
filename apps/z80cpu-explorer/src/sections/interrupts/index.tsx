// Interrupts section (nice-to-have post-MVP). Currently hosts only the
// INT vector byte input — the byte the bus places on `cpu.bus.data`
// during INT-acknowledge cycles (`nM1` low + `nIORQ` low).
//
// Forward-looking: a future build adds configurable INT-at-HC / NMI-at-HC
// generators here. The section is intentionally small for now so adding
// those later is a body extension, not a new section.

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
      {STR.interrupts.foldedSummary(formatHex(store.inputPins.intVector, 2))}
    </span>
  );
};

const VECTOR_INPUT_ID = "interrupts-int-vector";

const Body: Component = () => {
  const store = useStore();
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
