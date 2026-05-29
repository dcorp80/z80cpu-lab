import type { Component } from "solid-js";

export interface SectionModule {
  id: string;
  title: string;
  Header: Component;
  /**
   * One-line status shown in the header when the section is folded.
   * Omit when the Header is always visible and itself carries the status
   * (e.g. Breakpoints, REQ §6.2) — the frame skips the wrapper entirely
   * so the slot doesn't reserve flex width for nothing.
   */
  FoldedSummary?: Component;
  Body: Component;
}
