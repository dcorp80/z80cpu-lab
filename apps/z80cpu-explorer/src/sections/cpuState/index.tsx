import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const Header = () => null;
const FoldedSummary = () => (
  <span class="muted">{STR.cpuState.foldedEmpty}</span>
);
const Body = () => (
  <div class="placeholder">{STR.cpuState.bodyPlaceholder}</div>
);

export const cpuState: SectionModule = {
  id: "cpuState",
  title: STR.cpuState.title,
  Header,
  FoldedSummary,
  Body,
};
