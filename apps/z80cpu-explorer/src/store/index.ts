import type { CpuState } from "@dcorp80/z80cpu";
import type { Z80DebugContext } from "@dcorp80/z80cpu-debug";
import { createContext, createSignal, useContext } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type { Bus64k } from "../runloop/bus.ts";
import { MEM_SIZE } from "../runloop/bus.ts";
import type { PauseReason, RunLoop, RunStatus } from "../runloop/loop.ts";
import { defaultSectionIds } from "../sections/sectionRegistry.ts";
import {
  MAX_FILE_BYTES,
  type ProgramFile,
  type ProgramFileSession,
  type SectionUiState,
  type StorageBackend,
  type UiState,
} from "../storage/types.ts";
import { formatHex } from "../util/hex.ts";
import { shortId } from "../util/id.ts";
import type { InputPinsState, NewProgramFile, Store } from "./types.ts";

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

/** Apply a stored file order on top of the file list from the backend.
 *  Same reconciliation as sections — preserves stored order for known
 *  ids, appends unknown ids at the end. */
function reconcileFiles(
  stored: ProgramFile[],
  order: string[] | undefined,
): ProgramFile[] {
  if (!order || order.length === 0) return stored;
  const byId = new Map(stored.map((f) => [f.id, f]));
  const ordered: ProgramFile[] = [];
  for (const id of order) {
    const f = byId.get(id);
    if (f) {
      ordered.push(f);
      byId.delete(id);
    }
  }
  for (const f of stored) if (byId.has(f.id)) ordered.push(f);
  return ordered;
}

export interface CreateStoreDeps {
  backend: StorageBackend;
  loop: RunLoop;
  /**
   * Bus is held privately for action implementations (mem writes for file
   * load, INT vector mirroring). NOT exposed on the public Store interface
   * — sections see only signals and verbs (DESIGN §4 "Layering rule").
   * Reinit lives in the UI as a `window.location.reload()` button; no
   * targeted bus.reset is needed (DESIGN §7.3).
   */
  bus: Pick<Bus64k, "setIntVector" | "intVector" | "mem">;
  /**
   * Source of CPU register/flag snapshots for the cpuState section
   * (REQ §6.5). The store calls `dbg.state()` on each pause to refresh
   * the reactive `cpuState` accessor; tests inject a minimal stub.
   */
  dbg: Pick<Z80DebugContext, "state">;
}

export async function createAppStore(deps: CreateStoreDeps): Promise<Store> {
  const { backend, loop, bus, dbg } = deps;
  const loaded = await backend.loadUiState();
  const initialSections = loaded?.sections
    ? reconcileSections(loaded.sections)
    : defaultSections();

  const [sections, setSections] =
    createStore<SectionUiState[]>(initialSections);

  const storedFiles = await backend.listFiles();
  const initialFiles = reconcileFiles(storedFiles, loaded?.fileOrder);
  const [files, setFiles] = createStore<ProgramFile[]>(initialFiles);

  // Sessions start fresh each boot — autoload writes set them below.
  const initialSessions: Record<string, ProgramFileSession> = {};
  for (const f of initialFiles)
    initialSessions[f.id] = { lastLoadedAddr: null };
  const [fileSessions, setFileSessions] =
    createStore<Record<string, ProgramFileSession>>(initialSessions);

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

  // CPU state for the cpuState section (REQ §6.5). `cpuState` is the
  // last sampled snapshot — refreshed on every pause so the section
  // always shows what the CPU just did. `prevCpuStateAtBoundary` is the
  // snapshot taken at the previous instruction boundary (M1_T3_1 of the
  // next M1); the section uses it to highlight registers that changed
  // since the last boundary. `atInstructionBoundary` gates BOTH the
  // diff highlight AND the dim cue — false when the pause landed
  // anywhere other than M1_T3_1 (user pause mid-run, stepHC that
  // didn't align with a boundary, future hc-target breakpoint).
  const initialCpuState = dbg.state();
  const [cpuState, setCpuState] = createSignal<CpuState>(initialCpuState);
  const [prevCpuStateAtBoundary, setPrevCpuStateAtBoundary] =
    createSignal<CpuState>(initialCpuState);
  // Internal: snapshot at the most recent boundary. Lets us advance the
  // diff baseline correctly when a non-boundary pause sits between two
  // boundary pauses (without this we'd diff against the mid-instruction
  // state, which would falsely paint everything as "changed").
  let cpuStateAtBoundary = initialCpuState;
  const [atInstructionBoundary, setAtInstructionBoundary] = createSignal(false);

  function persistUi(): void {
    const state: UiState = {
      sections: unwrap(sections),
      fileOrder: files.map((f) => f.id),
    };
    // Fire-and-forget; commit-on-end means at most one call per user action.
    void backend.saveUiState(state);
  }

  // File mutations persist the file table AND the UI order (since order
  // changes can fall out of any file mutation). Backend is asynchronous;
  // the store updates synchronously so the UI reacts immediately.
  function persistFile(f: ProgramFile): void {
    void backend.putFile({ ...f, bytes: new Uint8Array(f.bytes) });
  }
  function persistFileDelete(id: string): void {
    void backend.deleteFile(id);
  }

  // Wire loop → reactive accessors.
  // The boundary heuristic: dbg fires `onInstruction` at M1_T3_1 of the
  // *next* M1 (see CLAUDE.md "trace timing model"). If that callback
  // fired since the last pause AND the pause reason is step-complete
  // (so the CPU stopped at the same edge), we're at an instruction
  // boundary and the register file is fully valid per the dbg's
  // contract. `pc-breakpoint` (M5+) also lands at a boundary.
  let instructionFiredSinceLastPause = false;

  loop.onPause((reason) => {
    setStatus("paused");
    setHc(loop.hc());
    setLastPauseReason(reason);

    const fromBoundary =
      (reason.kind === "step-complete" && instructionFiredSinceLastPause) ||
      reason.kind === "pc-breakpoint";
    instructionFiredSinceLastPause = false;

    const next = dbg.state();
    setCpuState(next);
    setAtInstructionBoundary(fromBoundary);
    if (fromBoundary) {
      // Old boundary snapshot becomes the diff baseline; new one takes
      // its place. A non-boundary pause in between leaves the baseline
      // untouched, so the diff still compares boundary-to-boundary.
      setPrevCpuStateAtBoundary(cpuStateAtBoundary);
      cpuStateAtBoundary = next;
    }
  });
  loop.onTick((h) => setHc(h));
  loop.onInstruction(() => {
    instructionFiredSinceLastPause = true;
    setInsnCount((n) => n + 1);
  });

  function toggleSectionFold(id: string): void {
    const idx = sections.findIndex((s) => s.id === id);
    if (idx < 0) return;
    setSections(idx, "folded", (f) => !f);
    persistUi();
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
    persistUi();
  }

  function updateSectionConfig(
    id: string,
    patch: Record<string, unknown>,
  ): void {
    const idx = sections.findIndex((s) => s.id === id);
    if (idx < 0) return;
    setSections(idx, "config", (cfg) => ({ ...cfg, ...patch }));
    persistUi();
  }

  // ── file actions ──────────────────────────────────────────────────

  /**
   * Defense at the public-verb boundary: addresses are 16-bit unsigned
   * integers. Replaces the older `addr & 0xffff` mask, which silently
   * turned negative numbers into high addresses (e.g. -1 → 0xFFFF). The
   * UI's `parseAddr16` already rejects out-of-range strings; this guard
   * catches programmatic mistakes (tests, future scripting, hotkeys).
   */
  function assertAddr16(addr: number, label: string): void {
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xffff) {
      throw new RangeError(`${label}: address out of range 0..0xFFFF: ${addr}`);
    }
  }

  /**
   * Write up to (MEM_SIZE - loadAddr) bytes from `src` into mem starting
   * at `loadAddr`. Returns the number of bytes that did NOT fit (0 when
   * the whole file landed cleanly). UI surfaces truncation via the
   * `truncated()` memo on the row; programmatic callers (autoload, boot,
   * tests) can act on the return value rather than discovering the loss
   * silently.
   */
  function writeBytesToMem(loadAddr: number, src: Uint8Array): number {
    const max = MEM_SIZE - loadAddr;
    const overflow = Math.max(0, src.length - max);
    bus.mem.set(src.subarray(0, src.length - overflow), loadAddr);
    return overflow;
  }

  // The session record exists for every file in `files` (addFile +
  // initialSessions both seed it), so `setFileSessions(id, …)` is just
  // an in-place update. Using `id in fileSessions` over the previous
  // truthy check would express intent more directly, but the simpler
  // form below works because the `Record<string, T>` setter creates the
  // key if missing.
  function setSessionLoaded(id: string, addr: number): void {
    setFileSessions(id, { lastLoadedAddr: addr });
  }

  function addFile(input: NewProgramFile): void {
    assertAddr16(input.loadAddr, "addFile loadAddr");
    // Storage cap per REQ §6.1. defaultPickFile already truncates the UI
    // path; this guard catches programmatic callers (tests, future
    // scripting) that bypass the picker.
    if (input.bytes.length > MAX_FILE_BYTES) {
      throw new RangeError(
        `addFile bytes: ${input.bytes.length} exceeds ${MAX_FILE_BYTES}-byte cap`,
      );
    }
    const id = shortId();
    const f: ProgramFile = {
      id,
      name: input.name,
      // .slice() always returns a fresh Uint8Array with its own
      // ArrayBuffer — true detach regardless of whether the input shared
      // a buffer with the caller.
      bytes: input.bytes.slice(),
      loadAddr: input.loadAddr,
      autoload: input.autoload === true,
    };
    setFiles(produce((arr) => arr.push(f)));
    setFileSessions(id, { lastLoadedAddr: null });
    persistFile(f);
    persistUi();
  }

  function removeFile(id: string): void {
    const idx = files.findIndex((f) => f.id === id);
    if (idx < 0) return;
    setFiles(produce((arr) => arr.splice(idx, 1)));
    setFileSessions(produce((s) => delete s[id]));
    persistFileDelete(id);
    persistUi();
  }

  function setFileLoadAddr(id: string, addr: number): void {
    assertAddr16(addr, "setFileLoadAddr");
    const idx = files.findIndex((f) => f.id === id);
    if (idx < 0) return;
    setFiles(idx, "loadAddr", addr);
    persistFile(unwrap(files[idx]));
  }

  function setFileAutoload(id: string, on: boolean): void {
    const idx = files.findIndex((f) => f.id === id);
    if (idx < 0) return;
    setFiles(idx, "autoload", on);
    persistFile(unwrap(files[idx]));
  }

  function reorderFiles(orderedIds: string[]): void {
    setFiles(
      produce((arr) => {
        const byId = new Map(arr.map((f) => [f.id, f]));
        const next: ProgramFile[] = [];
        for (const id of orderedIds) {
          const f = byId.get(id);
          if (f) {
            next.push(f);
            byId.delete(id);
          }
        }
        for (const f of arr) if (byId.has(f.id)) next.push(f);
        arr.splice(0, arr.length, ...next);
      }),
    );
    persistUi();
  }

  // Wrap a write so non-UI callers (boot autoload, reload-all, reinit)
  // never fail silently on truncation. The Program section's tooltip
  // still shows per-row overflow; this warning catches the case where
  // the section is folded or the call came from a non-UI path.
  function writeAndWarn(f: ProgramFile): void {
    const overflow = writeBytesToMem(f.loadAddr, f.bytes);
    if (overflow > 0) {
      console.warn(
        `[program] "${f.name}" truncated at $${formatHex(f.loadAddr, 4)}: ` +
          `${overflow} byte(s) past 0x10000`,
      );
    }
    setSessionLoaded(f.id, f.loadAddr);
  }

  function writeFileToMemory(id: string): void {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    writeAndWarn(f);
  }

  function loadAutoloadFiles(): void {
    // Files written in display order — overlap is last-write-wins
    // (REQ §6.1). loop over the SolidStore directly so order matches UI.
    for (const f of files) if (f.autoload) writeAndWarn(f);
  }

  function reloadAllFiles(): void {
    for (const f of files) writeAndWarn(f);
  }

  // Boot autoload — once the store is built, fire any autoload-flagged
  // files into memory so the user lands on a primed system at boot.
  loadAutoloadFiles();

  return {
    sections,
    toggleSectionFold,
    reorderSections,
    updateSectionConfig,
    status,
    hc,
    insnCount,
    lastPauseReason,
    cpuState,
    prevCpuStateAtBoundary,
    atInstructionBoundary,
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
    files,
    fileSessions,
    addFile,
    removeFile,
    setFileLoadAddr,
    setFileAutoload,
    reorderFiles,
    writeFileToMemory,
    loadAutoloadFiles,
    reloadAllFiles,
  };
}

const StoreContext = createContext<Store>();

export const StoreProvider = StoreContext.Provider;

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore called outside StoreProvider");
  return s;
}
