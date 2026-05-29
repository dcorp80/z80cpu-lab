import type { Accessor } from "solid-js";
import type { Store as SolidStore } from "solid-js/store";
import type { PauseReason, RunStatus } from "../runloop/loop.ts";
import type { SectionUiState } from "../storage/types.ts";

export interface InputPinsState {
  /** Byte placed on `cpu.bus.data` during INT-acknowledge cycles (REQ §6.4). */
  intVector: number;
}

export interface Store {
  // ── UI state
  readonly sections: SolidStore<SectionUiState[]>;
  toggleSectionFold(id: string): void;
  reorderSections(orderedIds: string[]): void;
  updateSectionConfig(id: string, patch: Record<string, unknown>): void;

  // ── run state
  readonly status: Accessor<RunStatus>;
  readonly hc: Accessor<number>;
  readonly insnCount: Accessor<number>;
  readonly lastPauseReason: Accessor<PauseReason | null>;

  run(): void;
  pause(): void;
  stepInstructions(n: number): void;
  stepHC(n: number): void;
  zeroHC(): void;

  // ── input pins
  readonly inputPins: SolidStore<InputPinsState>;
  setIntVector(byte: number): void;
}
