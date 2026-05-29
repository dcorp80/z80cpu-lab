import { type Component, For } from "solid-js";
import { SectionFrame } from "./sections/frame.tsx";
import { useStore } from "./store/index.ts";
import { STR } from "./style/strings.ts";

export const App: Component = () => {
  const store = useStore();
  return (
    <main class="app">
      <header class="app-header">
        <h1>{STR.app.title}</h1>
      </header>
      <div class="section-column">
        <For each={store.sections}>
          {(s) => <SectionFrame id={s.id} folded={s.folded} />}
        </For>
      </div>
    </main>
  );
};
