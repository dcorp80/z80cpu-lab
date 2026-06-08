// App-shell section (REQ §11). Topmost in the section order, collapsed
// by default. Header renders the Cold-boot button alongside the section
// title. Body hosts settings whose effect requires a reload — only
// Split RD/WR today. While the staged Split value differs from live,
// `isCollapseLocked` keeps the body open (the frame disables the fold
// chevron); Save flushes via `store.setSplitIo` (persist + reload),
// Discard reverts pending and folds the section directly.

import { type Component, Show } from "solid-js";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import type { SectionModule } from "../types.ts";

const SECTION_ID = "appShell";

const Header: Component = () => {
  const store = useStore();
  return (
    <button
      type="button"
      class="appshell-coldboot"
      onClick={() => store.coldBoot()}
      disabled={!store.isPaused()}
      title={STR.appShell.coldBootTooltip}
    >
      {STR.appShell.coldBoot}
    </button>
  );
};

const Body: Component = () => {
  const store = useStore();
  const onSave = () => {
    // setSplitIo persists + reloads (or, on persist failure, reverts BOTH
    // splitIo and pendingSplitIo so dirty clears and the user isn't
    // stranded — see store/index.ts setSplitIo catch handler). No need
    // to fold here: Save either reloads the page or stays open for the
    // user to react to the failure.
    store.setSplitIo(store.pendingSplitIo());
  };
  const onDiscard = () => {
    store.setPendingSplitIo(store.splitIo());
    // Fold here directly rather than reacting to splitIoDirty's edge in
    // a createEffect — the handler already knows it's clearing dirty
    // and we avoid auto-folding the section when the user just happens
    // to toggle the checkbox back to live without clicking Discard.
    const s = store.sections.find((sec) => sec.id === SECTION_ID);
    if (s && !s.folded) store.toggleSectionFold(SECTION_ID);
  };
  return (
    <div class="appshell-body">
      <label
        class="appshell-split"
        classList={{ "is-disabled": !store.isPaused() }}
        title={STR.appShell.splitTooltip}
      >
        <input
          type="checkbox"
          class="appshell-split-checkbox"
          aria-label={STR.appShell.splitAriaLabel}
          checked={store.pendingSplitIo()}
          disabled={!store.isPaused()}
          onChange={(e) => store.setPendingSplitIo(e.currentTarget.checked)}
        />
        <span class="appshell-split-label">{STR.appShell.splitLabel}</span>
      </label>
      <Show when={store.splitIoDirty()}>
        <div class="appshell-actions">
          <button
            type="button"
            class="appshell-save"
            onClick={onSave}
            disabled={!store.isPaused()}
            title={STR.appShell.saveTooltip}
          >
            {STR.appShell.save}
          </button>
          <button
            type="button"
            class="appshell-discard"
            onClick={onDiscard}
            title={STR.appShell.discardTooltip}
          >
            {STR.appShell.discard}
          </button>
        </div>
      </Show>
    </div>
  );
};

export const appShell: SectionModule = {
  id: SECTION_ID,
  title: STR.app.title,
  Header,
  Body,
  defaultFolded: true,
  isCollapseLocked: (store) => store.splitIoDirty(),
};
