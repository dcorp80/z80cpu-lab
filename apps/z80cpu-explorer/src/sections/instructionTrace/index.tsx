import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const Header = () => null;
const FoldedSummary = () => (
  <span class="muted">{STR.instructionTrace.foldedEmpty}</span>
);
const Body = () => (
  <div class="placeholder">{STR.instructionTrace.bodyPlaceholder}</div>
);

export const instructionTrace: SectionModule = {
  id: "instructionTrace",
  title: STR.instructionTrace.title,
  Header,
  FoldedSummary,
  Body,
};
