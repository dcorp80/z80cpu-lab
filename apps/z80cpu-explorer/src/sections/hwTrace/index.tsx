import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const Header = () => null;
const FoldedSummary = () => (
  <span class="muted">{STR.hwTrace.foldedEmpty}</span>
);
const Body = () => <div class="placeholder">{STR.hwTrace.bodyPlaceholder}</div>;

export const hwTrace: SectionModule = {
  id: "hwTrace",
  title: STR.hwTrace.title,
  Header,
  FoldedSummary,
  Body,
};
