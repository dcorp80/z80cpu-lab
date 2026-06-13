import { type Component, For } from "solid-js";
import { SectionFrame } from "./sections/frame.tsx";
import { useStore } from "./store/index.ts";

// The App-shell section (REQ §11) carries the app name as its section
// heading, so we don't render a separate page <h1> — that would print
// the same text twice (once as the page heading and once as the
// section heading directly below it) and create a duplicate landmark
// for screen readers.
export const App: Component = () => {
  const store = useStore();
  return (
    <main class="app">
      <div class="section-column">
        <For each={store.sections}>
          {(s) => <SectionFrame id={s.id} folded={s.folded} />}
        </For>
      </div>
    </main>
  );
};
