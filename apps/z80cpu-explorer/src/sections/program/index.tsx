import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const Header = () => null;
const FoldedSummary = () => (
  <span class="muted">{STR.program.foldedEmpty}</span>
);
const Body = () => <div class="placeholder">{STR.program.bodyPlaceholder}</div>;

export const program: SectionModule = {
  id: "program",
  title: STR.program.title,
  Header,
  FoldedSummary,
  Body,
};
