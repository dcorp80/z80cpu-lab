// App-shell section. Topmost in the section order, collapsed
// by default. Header renders the Cold-boot button alongside the section
// title. Body hosts settings whose effect requires a reload —
// Memory-fill byte, IO-fill byte, Split IO RD/WR. While any pending
// value differs from live, `isCollapseLocked` keeps the body open (the
// frame disables the fold chevron); Save flushes via
// `store.commitReloadSettings` (single atomic persist + reload across
// all three settings), Discard reverts every pending to live and folds
// the section directly.

import { type Component, For, Show } from "solid-js";
import { PAGE_SIZE_OPTIONS } from "../../config/defaults.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { HexAddrInput } from "../hexAddrInput.tsx";
import type { SectionModule } from "../types.ts";

const SECTION_ID = "appShell";
const MEM_INIT_INPUT_ID = "appshell-mem-init";
const IO_INIT_INPUT_ID = "appshell-io-init";
const MEM_PAGE_INPUT_ID = "appshell-mem-page";
const IO_PAGE_INPUT_ID = "appshell-io-page";

const Header: Component = () => {
  const store = useStore();
  return (
    <>
      <span
        class="appshell-version"
        title={STR.appShell.versionTooltip(__APP_VERSION__, __BUILD_SHA__)}
      >
        {STR.appShell.version(__APP_VERSION__, __BUILD_SHA__)}
      </span>
      <button
        type="button"
        class="btn btn-danger appshell-coldboot"
        onClick={() => store.coldBoot()}
        disabled={!store.isPaused()}
        title={STR.appShell.coldBootTooltip}
      >
        {STR.appShell.coldBoot}
      </button>
    </>
  );
};

const Body: Component = () => {
  const store = useStore();
  // Fold the section if it's currently open. Shared by Save and Discard
  // (both are explicit user-completed actions; the staging pattern treats
  // them as "done with this panel" events).
  // Save MUST fold *before* commitReloadSettings so the persisted
  // UiState captures folded=true — reload restores the persisted
  // snapshot, and without this the section would come back open even
  // though the user is done with it.
  const foldIfOpen = () => {
    const s = store.sections.find((sec) => sec.id === SECTION_ID);
    if (s && !s.folded) store.toggleSectionFold(SECTION_ID);
  };
  const onSave = () => {
    // commitReloadSettings persists every dirty pending value in one
    // saveUiState + reload (or, on persist failure, reverts ALL three
    // pendings and their live mirrors so the dirty form clears).
    // toggleSectionFold above is its own fire-and-forget persistUi;
    // IDB's readwrite queue serializes both writes on the `ui` store, so
    // commitReloadSettings' save (with folded=true + new values) is the
    // last-write-wins record before window.location.reload().
    foldIfOpen();
    store.commitReloadSettings();
  };
  const onDiscard = () => {
    store.setPendingMemInit(store.memInit());
    store.setPendingIoInit(store.ioInit());
    store.setPendingSplitIo(store.splitIo());
    foldIfOpen();
  };
  return (
    <div class="appshell-body">
      <div
        class="appshell-row"
        classList={{ "is-disabled": !store.isPaused() }}
        title={STR.appShell.memInitTooltip}
      >
        <label class="appshell-row-label" for={MEM_INIT_INPUT_ID}>
          {STR.appShell.memInitLabel}
        </label>
        <HexAddrInput
          id={MEM_INIT_INPUT_ID}
          class="appshell-byte-input"
          committed={store.pendingMemInit}
          padTo={2}
          maxValue={0xff}
          commit={(v) => {
            store.setPendingMemInit(v);
          }}
          ariaLabel={STR.appShell.memInitAriaLabel}
          title={STR.appShell.memInitTooltip}
          disabled={!store.isPaused()}
          size={4}
          maxLength={4}
        />
      </div>
      <div
        class="appshell-row"
        classList={{ "is-disabled": !store.isPaused() }}
        title={STR.appShell.ioInitTooltip}
      >
        <label class="appshell-row-label" for={IO_INIT_INPUT_ID}>
          {STR.appShell.ioInitLabel}
        </label>
        <HexAddrInput
          id={IO_INIT_INPUT_ID}
          class="appshell-byte-input"
          committed={store.pendingIoInit}
          padTo={2}
          maxValue={0xff}
          commit={(v) => {
            store.setPendingIoInit(v);
          }}
          ariaLabel={STR.appShell.ioInitAriaLabel}
          title={STR.appShell.ioInitTooltip}
          disabled={!store.isPaused()}
          size={4}
          maxLength={4}
        />
      </div>
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
      <Show when={store.reloadSettingsDirty()}>
        <div class="appshell-actions">
          <button
            type="button"
            class="btn btn-accent appshell-save"
            onClick={onSave}
            disabled={!store.isPaused()}
            title={STR.appShell.saveTooltip}
          >
            {STR.appShell.save}
          </button>
          <button
            type="button"
            class="btn btn-danger appshell-discard"
            onClick={onDiscard}
            title={STR.appShell.discardTooltip}
          >
            {STR.appShell.discard}
          </button>
        </div>
      </Show>
      {/* Live pane — non-destructive, no staging / fold-lock. Sits below
          the staged settings + (when present) Save/Discard row with a
          separator so the user doesn't conflate live and destructive
          settings. */}
      <div class="appshell-livepane">
        <label
          class="appshell-trace-insn"
          classList={{ "is-disabled": !store.isPaused() }}
          title={STR.appShell.traceInstructionsTooltip}
        >
          <input
            type="checkbox"
            class="appshell-trace-insn-checkbox"
            aria-label={STR.appShell.traceInstructionsAriaLabel}
            checked={store.traceInstructions()}
            disabled={!store.isPaused()}
            onChange={(e) =>
              store.setTraceInstructions(e.currentTarget.checked)
            }
          />
          <span class="appshell-trace-insn-label">
            {STR.appShell.traceInstructionsLabel}
          </span>
        </label>
        <div class="appshell-row" title={STR.appShell.memPageTooltip}>
          <label class="appshell-row-label" for={MEM_PAGE_INPUT_ID}>
            {STR.appShell.memPageLabel}
          </label>
          <select
            id={MEM_PAGE_INPUT_ID}
            class="appshell-page-select"
            aria-label={STR.appShell.memPageAriaLabel}
            value={String(store.memPageSize())}
            onChange={(e) =>
              store.setMemPageSize(Number(e.currentTarget.value))
            }
          >
            <For each={PAGE_SIZE_OPTIONS}>
              {(n) => (
                <option value={String(n)}>
                  {STR.pageNav.pageSizeOption(n)}
                </option>
              )}
            </For>
          </select>
        </div>
        <div class="appshell-row" title={STR.appShell.ioPageTooltip}>
          <label class="appshell-row-label" for={IO_PAGE_INPUT_ID}>
            {STR.appShell.ioPageLabel}
          </label>
          <select
            id={IO_PAGE_INPUT_ID}
            class="appshell-page-select"
            aria-label={STR.appShell.ioPageAriaLabel}
            value={String(store.ioPageSize())}
            onChange={(e) => store.setIoPageSize(Number(e.currentTarget.value))}
          >
            <For each={PAGE_SIZE_OPTIONS}>
              {(n) => (
                <option value={String(n)}>
                  {STR.pageNav.pageSizeOption(n)}
                </option>
              )}
            </For>
          </select>
        </div>
      </div>
    </div>
  );
};

export const appShell: SectionModule = {
  id: SECTION_ID,
  title: STR.app.title,
  Header,
  Body,
  defaultFolded: true,
  isCollapseLocked: (store) => store.reloadSettingsDirty(),
};
