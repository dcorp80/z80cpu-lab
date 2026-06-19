// Section module registry + shipped order.
//
// Section order belongs to shipped config (alongside `DEFAULT_LOOP_CONFIG`
// in `config/defaults.ts`), but it imports the section modules which
// transitively import the store — moving the array to config/defaults.ts
// creates a circular import that's already been tried. It stays here;
// a future Settings UI binds against `DEFAULT_SECTION_ORDER` from this
// module.

import { appShell } from "./appShell/index.tsx";
import { breakpoints } from "./breakpoints/index.tsx";
import { cpuState } from "./cpuState/index.tsx";
import { hwTrace } from "./hwTrace/index.tsx";
import { instructionTrace } from "./instructionTrace/index.tsx";
import { interrupts } from "./interrupts/index.tsx";
import { io } from "./io/index.tsx";
import { memory } from "./memory/index.tsx";
import { program } from "./program/index.tsx";
import type { SectionModule } from "./types.ts";

/** Top-to-bottom order new users see on first boot. Per-user
 *  reorder via drag persists through `StorageBackend`; the store's
 *  `reconcileSections` keeps stored order for known ids and appends
 *  any new ids at the end. */
export const DEFAULT_SECTION_ORDER: SectionModule[] = [
  appShell,
  cpuState,
  instructionTrace,
  breakpoints,
  program,
  memory,
  io,
  interrupts,
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

/** Initial `folded` value for a section id on a fresh boot (or when an
 *  id appears for the first time after a reconcile). Modules opt in to
 *  starting collapsed via `defaultFolded: true`; everything else opens. */
export function defaultSectionFolded(id: string): boolean {
  return REGISTRY.get(id)?.defaultFolded === true;
}
