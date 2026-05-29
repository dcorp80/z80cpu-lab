import { breakpoints } from "./breakpoints/index.tsx";
import { cpuState } from "./cpuState/index.tsx";
import { hwTrace } from "./hwTrace/index.tsx";
import { instructionTrace } from "./instructionTrace/index.tsx";
import { io } from "./io/index.tsx";
import { memory } from "./memory/index.tsx";
import { program } from "./program/index.tsx";
import type { SectionModule } from "./types.ts";

// Shipped default order, top → bottom (REQUIREMENTS §6).
export const DEFAULT_SECTION_ORDER: SectionModule[] = [
  program,
  breakpoints,
  cpuState,
  memory,
  instructionTrace,
  io,
  hwTrace,
];

const REGISTRY = new Map<string, SectionModule>(
  DEFAULT_SECTION_ORDER.map((s) => [s.id, s]),
);

export function getSectionModule(id: string): SectionModule | undefined {
  return REGISTRY.get(id);
}

export function defaultSectionIds(): string[] {
  return DEFAULT_SECTION_ORDER.map((s) => s.id);
}
