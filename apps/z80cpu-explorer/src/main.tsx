import { render } from "solid-js/web";
import { bootApp } from "./boot.tsx";
import "./styles.css";

// In production the page never unmounts, so there is no useful tear-down
// to run on `beforeunload` — the OS reclaims everything. The proper
// pre-close guard (warn on non-empty snapshot log + save-or-skip
// modal for destructive ops) lands in milestone 9. Browser tests
// drive `dispose` themselves through their own boot path.
async function main() {
  const { ui } = await bootApp();
  const root = document.getElementById("root");
  if (!root) throw new Error("#root not found");
  render(ui, root);
}

void main();
