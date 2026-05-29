import { createContext, createSignal, useContext } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type { Bus64k } from "../runloop/bus.ts";
import type { PauseReason, RunLoop, RunStatus } from "../runloop/loop.ts";
import { defaultSectionIds } from "../sections/sectionRegistry.ts";
import type {
  SectionUiState,
  StorageBackend,
  UiState,
} from "../storage/types.ts";
import type { InputPinsState, Store } from "./types.ts";

export type { Store } from "./types.ts";

function defaultSections(): SectionUiState[] {
  return defaultSectionIds().map((id) => ({ id, folded: false, config: {} }));
}

/** Merge a stored section list with the registry's known ids:
 *  - keep stored order for ids the registry still knows about
 *  - append any new registry ids (with default state) at the end
 *  - drop any stored ids the registry no longer knows about
 */
function reconcileSections(stored: SectionUiState[]): SectionUiState[] {
  const known = new Set(defaultSectionIds());
  const keep = stored.filter((s) => known.has(s.id));
  const seen = new Set(keep.map((s) => s.id));
  const missing = defaultSectionIds()
    .filter((id) => !seen.has(id))
    .map<SectionUiState>((id) => ({ id, folded: false, config: {} }));
  return [...keep, ...missing];
}

export interface CreateStoreDeps {
  backend: StorageBackend;
  loop: RunLoop;
  /**
   * Bus is held privately for action implementations (e.g. `setIntVector`
   * delegates to `bus.setIntVector`). NOT exposed on the public Store
   * interface — sections see only signals and verbs (DESIGN §4).
   */
  bus: Pick<Bus64k, "setIntVector" | "intVector">;
}

export async function createAppStore(deps: CreateStoreDeps): Promise<Store> {
  const { backend, loop, bus } = deps;
  const loaded = await backend.loadUiState();
  const initialSections = loaded?.sections
    ? reconcileSections(loaded.sections)
    : defaultSections();

  const [sections, setSections] =
    createStore<SectionUiState[]>(initialSections);

  const [status, setStatus] = createSignal<RunStatus>(loop.status());
  const [hc, setHc] = createSignal(loop.hc());
  const [insnCount, setInsnCount] = createSignal(0);
  const [lastPauseReason, setLastPauseReason] =
    createSignal<PauseReason | null>(null);

  // UI mirror of the bus-owned INT vector. Bus is authoritative (the
  // resolver reads it on every INT-ack); the SolidStore copy exists
  // only so sections re-render when the user edits the value.
  const [inputPins, setInputPins] = createStore<InputPinsState>({
    intVector: bus.intVector(),
  });

  function persist(): void {
    const state: UiState = { sections: unwrap(sections) };
    // Fire-and-forget; commit-on-end means at most one call per user action.
    void backend.saveUiState(state);
  }

  // Wire loop → reactive accessors.
  loop.onPause((reason) => {
    setStatus("paused");
    setHc(loop.hc());
    setLastPauseReason(reason);
  });
  loop.onTick((h) => setHc(h));
  loop.onInstruction(() => setInsnCount((n) => n + 1));

  function toggleSectionFold(id: string): void {
    const idx = sections.findIndex((s) => s.id === id);
    if (idx < 0) return;
    setSections(idx, "folded", (f) => !f);
    persist();
  }

  function reorderSections(orderedIds: string[]): void {
    setSections(
      produce((arr) => {
        const byId = new Map(arr.map((s) => [s.id, s]));
        const next: SectionUiState[] = [];
        for (const id of orderedIds) {
          const s = byId.get(id);
          if (s) {
            next.push(s);
            byId.delete(id);
          }
        }
        // Anything not named in orderedIds keeps its original relative order.
        for (const s of arr) if (byId.has(s.id)) next.push(s);
        arr.splice(0, arr.length, ...next);
      }),
    );
    persist();
  }

  function updateSectionConfig(
    id: string,
    patch: Record<string, unknown>,
  ): void {
    const idx = sections.findIndex((s) => s.id === id);
    if (idx < 0) return;
    setSections(idx, "config", (cfg) => ({ ...cfg, ...patch }));
    persist();
  }

  return {
    sections,
    toggleSectionFold,
    reorderSections,
    updateSectionConfig,
    status,
    hc,
    insnCount,
    lastPauseReason,
    run() {
      // Clear stale pause reason so the next paused-state render shows
      // the reason for the upcoming pause, not the previous one.
      setLastPauseReason(null);
      loop.run();
      setStatus("running");
    },
    pause() {
      loop.pause();
    },
    stepInstructions(n: number) {
      if (n <= 0) return;
      setLastPauseReason(null);
      loop.stepInstructions(n);
      setStatus("stepping");
    },
    stepHC(n: number) {
      if (n <= 0) return;
      setLastPauseReason(null);
      loop.stepHC(n);
      setStatus("stepping");
    },
    zeroHC() {
      loop.zeroHC();
      setHc(0);
      setInsnCount(0);
    },
    inputPins,
    setIntVector(byte: number) {
      // Bus is authoritative; mirror into the UI store so dependent
      // sections re-render. Bus masks again at its boundary.
      bus.setIntVector(byte);
      setInputPins("intVector", bus.intVector());
    },
  };
}

const StoreContext = createContext<Store>();

export const StoreProvider = StoreContext.Provider;

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore called outside StoreProvider");
  return s;
}
