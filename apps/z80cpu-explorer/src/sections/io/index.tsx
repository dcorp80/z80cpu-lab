import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const Header = () => null;
const FoldedSummary = () => <span class="muted">{STR.io.foldedEmpty}</span>;
const Body = () => <div class="placeholder">{STR.io.bodyPlaceholder}</div>;

export const io: SectionModule = {
  id: "io",
  title: STR.io.title,
  Header,
  FoldedSummary,
  Body,
};
