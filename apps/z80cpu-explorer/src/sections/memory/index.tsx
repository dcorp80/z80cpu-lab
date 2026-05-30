import type { Component } from "solid-js";
import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const Header: Component = () => null;
const FoldedSummary = () => <span class="muted">{STR.memory.foldedEmpty}</span>;
const Body = () => <div class="placeholder">{STR.memory.bodyPlaceholder}</div>;

export const memory: SectionModule = {
  id: "memory",
  title: STR.memory.title,
  Header,
  FoldedSummary,
  Body,
};
