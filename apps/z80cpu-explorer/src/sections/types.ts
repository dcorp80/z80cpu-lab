import type { Component } from "solid-js";
import type { Store } from "../store/index.ts";

export interface SectionModule {
  id: string;
  title: string;
  Header: Component;
  /**
   * One-line status shown in the header when the section is folded.
   * Omit when the Header is always visible and itself carries the status
   * (e.g. Breakpoints) — the frame skips the wrapper entirely
   * so the slot doesn't reserve flex width for nothing.
   */
  FoldedSummary?: Component;
  Body: Component;
  /**
   * Initial fold state when no persisted state exists (fresh boot OR a
   * registry id appearing for the first time after a reconcile). Omit
   * for the common "open on first boot" case — defaults to `false`.
   * Persisted user fold state always wins after the first interaction.
   */
  defaultFolded?: boolean;
  /**
   * When this returns `true` the frame disables the fold chevron — the
   * section refuses to collapse. Used by the App-shell section (REQ
   * §11) to lock the body open while staged settings are unsaved; the
   * section's own Save/Discard buttons clear the lock. Called from
   * within Solid reactive context.
   */
  isCollapseLocked?: (store: Store) => boolean;
}
