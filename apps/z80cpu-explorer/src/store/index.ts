import type { CpuState } from "@dcorp80/z80cpu";
import type { Z80DebugContext } from "@dcorp80/z80cpu-debug";
import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  useContext,
} from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import {
  DEFAULT_HW_TRACE_CONFIG,
  DEFAULT_INSTRUCTION_RING_CAP,
  DEFAULT_IO_BYTES_PER_ROW,
  DEFAULT_MEMORY_BYTES_PER_ROW,
  DEFAULT_UI_CONFIG,
  IO_BYTES_PER_ROW_OPTIONS,
  MEMORY_BYTES_PER_ROW_OPTIONS,
  type UiConfig,
} from "../config/defaults.ts";
import type { Bus64k } from "../runloop/bus.ts";
import { MEM_SIZE } from "../runloop/bus.ts";
import { HwTraceBuffer } from "../runloop/hwTrace.ts";
import type { PauseReason, RunLoop, RunStatus } from "../runloop/loop.ts";
import {
  defaultSectionFolded,
  defaultSectionIds,
} from "../sections/sectionRegistry.ts";
import {
  type Breakpoint,
  MAX_FILE_BYTES,
  type ProgramFile,
  type ProgramFileSession,
  type SectionUiState,
  type StorageBackend,
  type UiState,
} from "../storage/types.ts";
import { formatHex } from "../util/hex.ts";
import { shortId } from "../util/id.ts";
import { TraceRing } from "./traceRing.ts";
import type {
  BreakpointPatch,
  BusAccessRecord,
  CursorsState,
  InputPinsState,
  NewBreakpoint,
  NewProgramFile,
  Store,
} from "./types.ts";

export type { Store } from "./types.ts";

function defaultSections(): SectionUiState[] {
  return defaultSectionIds().map((id) => ({
    id,
    folded: defaultSectionFolded(id),
    config: {},
  }));
}

/** Merge a stored section list with the registry's known ids:
 *  - keep stored order for ids the registry still knows about
 *  - inject any new registry ids at their `DEFAULT_SECTION_ORDER` index
 *    rather than at the end — REQ §11 wants the App-shell to land at
 *    the top for upgrading users, not at the bottom they'd never look at
 *  - drop any stored ids the registry no longer knows about
 */
function reconcileSections(stored: SectionUiState[]): SectionUiState[] {
  const order = defaultSectionIds();
  const known = new Set(order);
  const keep = stored.filter((s) => known.has(s.id));
  const seen = new Set(keep.map((s) => s.id));
  const out: SectionUiState[] = [...keep];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (seen.has(id)) continue;
    // Find the insertion index: first kept section whose registry index
    // is greater than this one. Falls through to the end if none.
    let insertAt = out.length;
    for (let j = 0; j < out.length; j++) {
      if (order.indexOf(out[j].id) > i) {
        insertAt = j;
        break;
      }
    }
    out.splice(insertAt, 0, {
      id,
      folded: defaultSectionFolded(id),
      config: {},
    });
  }
  return out;
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

// Effective-clock indicator band (REQ §11). A frame's (Δhc, Δt) yields a
// meaningful T-state rate only when it did a measurable, non-idle chunk of
// work: dt below the floor is at/under `performance.now()` resolution (and
// risks divide-by-zero); dt above the ceiling means the frame was mostly
// idle/think-time (a single step, a backgrounded tab) — skip it and hold
// the last value rather than flash a misleading dip.
const CLOCK_DT_FLOOR_MS = 1;
const CLOCK_DT_CEILING_MS = 250;

export interface CreateStoreDeps {
  backend: StorageBackend;
  loop: RunLoop;
  /**
   * Bus is held privately for action implementations (mem/IO writes for
   * file load + hex grid edits, INT vector mirroring, last-touched
   * sampling on pause). NOT exposed on the public Store interface —
   * sections see only signals and verbs (DESIGN §4 "Layering rule").
   * Reinit lives in the UI as a `window.location.reload()` button; no
   * targeted bus.reset is needed (DESIGN §7.3).
   */
  bus: Omit<Bus64k, "resolve">;
  /**
   * Source of CPU register/flag snapshots for the cpuState section
   * (REQ §6.5). The store calls `dbg.state()` on each pause to refresh
   * the reactive `cpuState` accessor; tests inject a minimal stub.
   */
  dbg: Pick<Z80DebugContext, "state">;
  /**
   * HW-trace buffer (DESIGN §3.2). Optional — when absent the store
   * default-constructs a fresh `HwTraceBuffer` from
   * `DEFAULT_HW_TRACE_CONFIG`, which keeps tests that don't care about
   * HW-trace state from having to plumb a buffer through. Boot.tsx
   * passes the same instance it gives to `createRunLoop`.
   */
  hwTrace?: HwTraceBuffer;
  /**
   * Wallclock source for the effective-clock indicator (REQ §11). Defaults
   * to `performance.now`. Injected by tests so the measured rate is
   * deterministic.
   */
  now?: () => number;
  /**
   * Pre-fetched UI state. Boot reads `backend.loadUiState()` before
   * `makeBus64k` (it needs `splitIo` from persistence to size the IO
   * planes), so passing the same result through avoids a second
   * round-trip on real backends. When omitted the store loads itself.
   */
  preloadedUi?: UiState | null;
}

export async function createAppStore(deps: CreateStoreDeps): Promise<Store> {
  const { backend, loop, bus, dbg } = deps;
  const hwTrace = deps.hwTrace ?? new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);
  const now = deps.now ?? (() => performance.now());
  const loaded =
    deps.preloadedUi !== undefined
      ? deps.preloadedUi
      : await backend.loadUiState();
  const initialSections = loaded?.sections
    ? reconcileSections(loaded.sections)
    : defaultSections();

  const [sections, setSections] =
    createStore<SectionUiState[]>(initialSections);

  const storedFiles = await backend.listFiles();
  const initialFiles = reconcileFiles(storedFiles, loaded?.fileOrder);
  const [files, setFiles] = createStore<ProgramFile[]>(initialFiles);

  const initialBreakpoints = await backend.loadBreakpoints();
  const [breakpoints, setBreakpoints] =
    createStore<Breakpoint[]>(initialBreakpoints);
  // Loop is armed at the very end of boot (after autoload), so persisted
  // BPs are live before the user does anything but only after mem reflects
  // the autoloaded files.

  // UI throttle cadence (REQ §7.5). Persisted via UiState; falls back to
  // the shipped default when the backend has no record or the stored
  // value is malformed (older backend, corrupt write).
  function sanitizeUiConfig(raw: unknown): UiConfig {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_UI_CONFIG };
    const candidate = raw as Partial<UiConfig>;
    const n = candidate.flushEveryNFrames;
    const flushEveryNFrames =
      typeof n === "number" && Number.isInteger(n) && n >= 1
        ? n
        : DEFAULT_UI_CONFIG.flushEveryNFrames;
    return { flushEveryNFrames };
  }
  const [uiConfig, setUiConfigSignal] = createSignal<UiConfig>(
    sanitizeUiConfig(loaded?.uiConfig),
  );

  // Sessions start fresh each boot — autoload writes set them below.
  const initialSessions: Record<string, ProgramFileSession> = {};
  for (const f of initialFiles)
    initialSessions[f.id] = { lastLoadedAddr: null };
  const [fileSessions, setFileSessions] =
    createStore<Record<string, ProgramFileSession>>(initialSessions);

  const [status, setStatus] = createSignal<RunStatus>(loop.status());
  const isPaused: Accessor<boolean> = () => status() === "paused";
  const [hc, setHc] = createSignal(loop.hc());
  const [insnCount, setInsnCount] = createSignal(0);
  // Effective clock-speed indicator (REQ §11). `null` until the first valid
  // frame measurement (and after zeroHC) → the view shows "—". The value is
  // held across a pause (the view greys it): it's the speed of the run that
  // just ended. Baseline locals track the previous tick's (hc, now) for the
  // frame-to-frame delta; reseeded in `run()`.
  const [effClockMHz, setEffClockMHz] = createSignal<number | null>(null);
  let clockBaseHc = 0;
  let clockBaseNow = 0;
  let clockBaselined = false;
  const [lastPauseReason, setLastPauseReason] =
    createSignal<PauseReason | null>(null);

  // UI mirror of the bus-owned input pins (REQ §6.4). Bus is
  // authoritative (the resolver applies them to cpu.bus on every
  // preEdge); the SolidStore copy exists so sections re-render when the
  // user toggles a checkbox or edits the INT vector byte.
  const [inputPins, setInputPins] = createStore<InputPinsState>({
    nINT: bus.getInputPin("nINT"),
    nNMI: bus.getInputPin("nNMI"),
    nRESET: bus.getInputPin("nRESET"),
    nBUSRQ: bus.getInputPin("nBUSRQ"),
    nWAIT: bus.getInputPin("nWAIT"),
    intVector: bus.intVector(),
  });
  /** Pull the bus's current pin levels into the SolidStore mirror.
   *  Used after each frame's edges so nNMI's post-edge auto-clear
   *  ([[feedback-nmi-pulse-semantics]]) propagates to the checkbox
   *  state without a per-edge subscription. Cheap — five reads + a
   *  shallow store update, gated on actual change inside Solid. */
  function syncInputPinsFromBus(): void {
    setInputPins({
      nINT: bus.getInputPin("nINT"),
      nNMI: bus.getInputPin("nNMI"),
      nRESET: bus.getInputPin("nRESET"),
      nBUSRQ: bus.getInputPin("nBUSRQ"),
      nWAIT: bus.getInputPin("nWAIT"),
    });
  }

  // Instruction-trace ring (DESIGN §3.1). Reactivity rides a version
  // counter — sections createMemo on `traceRingVersion()` and pull
  // records via `ring.at(...)`, which is cheap and avoids per-record
  // signal allocation at push rate.
  //
  // Two version signals:
  //   - `traceRingVersion`: raw, bumps on every push. Tests + any
  //     consumer that genuinely needs every-push fidelity read this.
  //   - `traceRingVersionThrottled`: rAF-debounced during run, flushed
  //     immediately on pause-edge and whenever the loop is already
  //     paused (REQ §7.5). Section consumers (folded summary, body
  //     memos) read this — at full speed the body would otherwise
  //     diff ~10k DOM rows on every push and starve rAF.
  //
  // `insnCountThrottled` rides the same per-frame flush — the
  // Breakpoints status line and the trace folded summary need a
  // human-readable count, not a per-instruction signal storm.
  const traceRing = new TraceRing(DEFAULT_INSTRUCTION_RING_CAP);
  const [traceRingVersion, setTraceRingVersion] = createSignal(0);
  const [traceRingVersionThrottled, setTraceRingVersionThrottled] =
    createSignal(0);
  const [insnCountThrottled, setInsnCountThrottled] = createSignal(0);

  // HW-trace reactive mirrors (DESIGN §3.2). `hwTraceVersion` follows
  // the buffer's own `version()` — only bumped when it advances, so
  // `'disabled'` mode produces zero signal churn. `hwTraceMode`
  // mirrors `buffer.getMode()` so section UI can render reactively;
  // setHwTraceMode keeps both in sync.
  const [hwTraceVersion, setHwTraceVersion] = createSignal(hwTrace.version());
  const [hwTraceMode, setHwTraceModeSig] = createSignal<"disabled" | "ring">(
    hwTrace.getMode(),
  );
  let lastSeenHwTraceVersion = hwTrace.version();
  let runFlushScheduled = false;
  // Set on `dispose()`; the rAF callback checks it so a frame queued
  // before teardown can't fire a signal write after the consuming
  // component tree is gone. Matters for tests that swap rAF for a
  // controllable scheduler and for HMR.
  let disposed = false;
  // Schedule under rAF when available; setTimeout fallback for Node /
  // environments where rAF isn't defined. The fallback isn't perfect
  // (it doesn't align with paint) but keeps the contract — "at most one
  // bump per scheduler tick" — in test environments too.
  const scheduleFrame: (cb: () => void) => void =
    typeof requestAnimationFrame === "function"
      ? (cb) => {
          requestAnimationFrame(() => cb());
        }
      : (cb) => {
          setTimeout(cb, 16);
        };
  /** Single rAF-coalesced flush of all run-state mirrors:
   *    - traceRingVersionThrottled  (per-instruction trace ring push)
   *    - insnCountThrottled         (per-instruction counter)
   *  Both are bumped together — they tick on the same event, and
   *  consumers (trace folded summary, BP status line) typically read
   *  both. Sharing one schedule keeps the hot-path cost flat as we
   *  add more throttled mirrors. */
  function flushRunState(): void {
    setTraceRingVersionThrottled(traceRing.version());
    setInsnCountThrottled(insnCount());
  }
  function bumpThrottled(): void {
    // If the loop is already paused (boot, step-pause, post-BP),
    // there's nothing to coalesce — fire synchronously so tests and
    // single-step pauses don't have to wait for a frame.
    if (loop.status() === "paused") {
      flushRunState();
      return;
    }
    if (runFlushScheduled) return;
    runFlushScheduled = true;
    // Capture the cadence at schedule time. Changing `uiConfig` mid-
    // flight does not retroactively shorten / extend the current wait
    // — it takes effect on the next bump cycle, which keeps the timing
    // model simple.
    let pending = Math.max(1, uiConfig().flushEveryNFrames | 0);
    const tick = (): void => {
      if (disposed) return;
      pending--;
      if (pending > 0) {
        scheduleFrame(tick);
        return;
      }
      flushRunState();
      runFlushScheduled = false;
    };
    scheduleFrame(tick);
  }

  // View cursors (DESIGN §3.6, REQ §7.2). Both cursors default to live;
  // detach/snap actions follow the same pattern. zeroHC snaps both back
  // since the rebased HC counter would invalidate any pinned anchor.
  const [cursors, setCursors] = createStore<CursorsState>({
    instructionTrace: { mode: "live" },
    hwTrace: { mode: "live" },
  });

  // Memory / IO read paths. The `memByte` / `ioByte` accessors track
  // their version signal so any consumer createMemo re-runs after
  // writes. Bumped from `writeAndWarn` (file load / autoload /
  // reload-all), `setMemByte`, `setIoByte`. `zeroHC` does NOT bump
  // because zero-HC leaves memory and IO alone (REQ §7.3).
  const [memVersion, setMemVersion] = createSignal(0);
  const bumpMemVersion = (): void => {
    setMemVersion((v) => v + 1);
  };
  const [ioVersion, setIoVersion] = createSignal(0);
  const bumpIoVersion = (): void => {
    setIoVersion((v) => v + 1);
  };
  // WR-plane version signal (REQ §11 split mode). Only meaningful when
  // `splitIo()` is true; in joined mode the WR plane isn't allocated and
  // the section's WR pane is hidden, so harmless bumps just trigger
  // no-op re-renders the consumer doesn't subscribe to. Bumped on every
  // pause (CPU may have OUTed during run) and on zeroHC.
  const [ioVersionWrite, setIoVersionWrite] = createSignal(0);
  const bumpIoVersionWrite = (): void => {
    setIoVersionWrite((v) => v + 1);
  };

  // Watch-window state for Memory and IO sections (M7). Persisted via
  // `SectionUiState.config.watchAddr`, read through plain accessors
  // (Solid stores track property reads, so the accessor re-runs when
  // the relevant slice updates). Jump-request signals are in-memory
  // event counters — pressing Enter on the watch input bumps them and
  // the section body reacts with a scrollIntoView side-effect.
  const watchAddrFromConfig = (sectionId: string): number => {
    const s = sections.find((sec) => sec.id === sectionId);
    const v = s?.config.watchAddr;
    return typeof v === "number" ? v : 0;
  };
  const memWatchAddr: Accessor<number> = () => watchAddrFromConfig("memory");
  const ioWatchAddr: Accessor<number> = () => watchAddrFromConfig("io");
  // WR-plane watch lives under its own config key so split-mode users
  // can park each pane at a different port without one fighting the other.
  const ioWatchAddrWrite: Accessor<number> = () => {
    const s = sections.find((sec) => sec.id === "io");
    const v = s?.config.watchAddrWrite;
    return typeof v === "number" ? v : 0;
  };
  const [memWatchJumpVersion, setMemWatchJumpVersion] = createSignal(0);
  const [ioWatchJumpVersion, setIoWatchJumpVersion] = createSignal(0);
  const [ioWatchJumpVersionWrite, setIoWatchJumpVersionWrite] = createSignal(0);

  // Bytes-per-row — same storage path as watchAddr (section config).
  // Defaults to the matching `DEFAULT_*_BYTES_PER_ROW`; invalid stored
  // values (corrupt backend, downgrade) fall back to the default.
  const bytesPerRowFromConfig = (
    sectionId: string,
    options: ReadonlyArray<number>,
    fallback: number,
  ): number => {
    const s = sections.find((sec) => sec.id === sectionId);
    const v = s?.config.bytesPerRow;
    return typeof v === "number" && options.includes(v) ? v : fallback;
  };
  const memBytesPerRow: Accessor<number> = () =>
    bytesPerRowFromConfig(
      "memory",
      MEMORY_BYTES_PER_ROW_OPTIONS,
      DEFAULT_MEMORY_BYTES_PER_ROW,
    );
  const ioBytesPerRow: Accessor<number> = () =>
    bytesPerRowFromConfig(
      "io",
      IO_BYTES_PER_ROW_OPTIONS,
      DEFAULT_IO_BYTES_PER_ROW,
    );

  // IO render mode (REQ §6.7). '16bit' renders the default 64K-port grid;
  // '8bit' renders 256 cells where each write broadcasts to all 256
  // high-byte aliases. Persisted via the IO section's config; falls
  // back to '16bit' for older backends or corrupt values.
  const ioViewMode: Accessor<"16bit" | "8bit"> = () => {
    const s = sections.find((sec) => sec.id === "io");
    const v = s?.config.viewMode;
    return v === "8bit" ? "8bit" : "16bit";
  };

  // IO split mode (REQ §11). Persisted via the IO section's config; the
  // bus's `splitIo` is fixed at construction (boot reads the same key
  // and passes it to `makeBus64k`). When the config is present, this
  // accessor returns it — so a fresh `setSplitIo` updates the checkbox
  // immediately, before the reload completes. When absent (fresh boot
  // with no prior persist) we fall back to `bus.splitIo`, the runtime
  // authority — this is what lets `DEFAULT_BUS_CONFIG.splitIo: true`
  // light up the UI without needing a stored config to back it.
  // Malformed persisted values (non-boolean) also take the fallback.
  const splitIo: Accessor<boolean> = () => {
    const s = sections.find((sec) => sec.id === "io");
    const v = s?.config.splitIo;
    return typeof v === "boolean" ? v : bus.splitIo;
  };

  // App-shell pending value for Split RD/WR (REQ §11). The checkbox in
  // the App-shell body binds to this, NOT to `splitIo()` directly —
  // toggling stages a value, Save flushes via `setSplitIo` (which
  // persists + reloads), Discard reverts to live. `splitIoDirty` drives
  // the section's fold-lock and Save/Discard visibility. Initialized
  // from `splitIo()`; the live value is the source of truth on boot,
  // every subsequent change is a deliberate user edit.
  const [pendingSplitIo, setPendingSplitIo] = createSignal(splitIo());
  const splitIoDirty: Accessor<boolean> = createMemo(
    () => pendingSplitIo() !== splitIo(),
  );
  function assertBytesPerRow(
    n: number,
    options: ReadonlyArray<number>,
    label: string,
  ): void {
    if (!options.includes(n)) {
      throw new RangeError(
        `${label}: must be one of ${options.join(", ")}; got ${n}`,
      );
    }
  }

  // Bus last-touched snapshots (REQ §6.6 / §6.7 folded summaries).
  // Sampled from the bus on every pause-edge so consumers see a frozen
  // "what the CPU did up to the pause" reading. `null` initial value
  // matches the bus's sentinel-of-"no such cycle yet".
  const [lastMemRead, setLastMemRead] = createSignal<BusAccessRecord | null>(
    null,
  );
  const [lastMemWrite, setLastMemWrite] = createSignal<BusAccessRecord | null>(
    null,
  );
  const [lastIoRead, setLastIoRead] = createSignal<BusAccessRecord | null>(
    null,
  );
  const [lastIoWrite, setLastIoWrite] = createSignal<BusAccessRecord | null>(
    null,
  );

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
      uiConfig: uiConfig(),
    };
    // Fire-and-forget; commit-on-end means at most one call per user action.
    void backend.saveUiState(state);
  }

  function setUiConfig(patch: Partial<UiConfig>): void {
    const current = uiConfig();
    let nextFlush = current.flushEveryNFrames;
    if (patch.flushEveryNFrames !== undefined) {
      const n = patch.flushEveryNFrames;
      if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(
          `setUiConfig flushEveryNFrames: integer ≥ 1 required, got ${n}`,
        );
      }
      nextFlush = n;
    }
    if (nextFlush === current.flushEveryNFrames) return;
    setUiConfigSignal({ flushEveryNFrames: nextFlush });
    persistUi();
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
    // Pause flushes any pending throttle so the trace section + status
    // line snap to the final state on the same tick the user paused,
    // not the next rAF.
    flushRunState();
    // Sample bus last-touched (REQ §6.6 / §6.7). Snapshots — sections
    // read these on pause and don't see per-edge churn during run.
    setLastMemRead(bus.lastMemRead());
    setLastMemWrite(bus.lastMemWrite());
    setLastIoRead(bus.lastIoRead());
    setLastIoWrite(bus.lastIoWrite());
    // The CPU may have written to mem/IO during the run that just
    // ended; those writes don't flow through `setMemByte`/`setIoByte`
    // so the version signals never bumped. Bump unconditionally on
    // pause so the Memory and IO grids re-read. The grids are frozen
    // during run (§7.5), so one bump per pause is the right cadence
    // — even when no write occurred, the cost is a re-render that
    // produces identical DOM. In joined mode the RD plane catches CPU
    // OUT cycles, so `bumpIoVersion` covers both directions; in split
    // mode `bumpIoVersionWrite` brings the WR pane along.
    bumpMemVersion();
    bumpIoVersion();
    bumpIoVersionWrite();
    // nNMI auto-clears in postEdge (1-HC pulse,
    // [[feedback-nmi-pulse-semantics]]); resync the mirror so the
    // checkbox UI returns to unchecked. Also catches any other pin
    // touched by future bus-internal logic.
    syncInputPinsFromBus();
  });
  loop.onTick((h) => {
    setHc(h);
    // Effective clock (REQ §11): frame-to-frame T-state rate, measured
    // only across genuine *run* frames. The indicator is "host throughput
    // at run speed" — stepping is not run speed, so we gate on
    // `loop.status() === "running"` and hold the last value through step
    // frames (a step-complete pause flips status before this tick fires).
    // We also require a measurable, non-idle chunk of work (dt band; the
    // band's floor guards against divide-by-zero, the ceiling against
    // idle/think-time dips). `zeroHC` clears `clockBaselined`, so the
    // first post-zeroHC frame reseeds rather than measuring against a
    // rebased counter. The baseline advances every tick, so a measured
    // frame always compares against the immediately-previous one.
    const tNow = now();
    if (clockBaselined && loop.status() === "running") {
      const dHc = h - clockBaseHc;
      const dt = tNow - clockBaseNow;
      if (dHc > 0 && dt >= CLOCK_DT_FLOOR_MS && dt <= CLOCK_DT_CEILING_MS) {
        // clock Hz = (dHc / 2 T-states) / (dt / 1000 s); ÷1e6 → MHz.
        setEffClockMHz(dHc / 2 / (dt / 1000) / 1e6);
      }
    }
    clockBaseHc = h;
    clockBaseNow = tNow;
    clockBaselined = true;
    // HW-trace buffer advances `version()` on each endFrame (and on
    // clear/setMode). Only bump the reactive mirror when it actually
    // changed — keeps `'disabled'` mode free of signal churn and avoids
    // re-running consumer memos on no-change frames.
    const v = hwTrace.version();
    if (v !== lastSeenHwTraceVersion) {
      lastSeenHwTraceVersion = v;
      setHwTraceVersion(v);
    }
    // Resync input-pin mirror during run too, so a long run that fires
    // an NMI mid-frame unchecks the checkbox by the next tick (without
    // waiting for the user to pause).
    syncInputPinsFromBus();
  });
  loop.onInstruction((trace, hcAtComplete) => {
    instructionFiredSinceLastPause = true;
    setInsnCount((n) => n + 1);
    // DESIGN §3.1: copy out of the dbg's double-buffered trace into the
    // ring's stable record. The handler must not retain `trace` past the
    // callback — `ring.push` does the byte-by-byte copy.
    traceRing.push(trace, hcAtComplete);
    setTraceRingVersion((v) => v + 1);
    bumpThrottled();
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
   * Same boundary defense for byte values entering the public verbs.
   * The hex grid's edit input already validates via `parseHex` + range
   * check; this catches programmatic mistakes (tests, future scripting).
   */
  function assertByte(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`${label}: byte out of range 0..0xFF: ${value}`);
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
    // Mem changed — bump the reactive version so the instruction-trace
    // PC preview (and M7 hex grid) re-render.
    bumpMemVersion();
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

  // ── breakpoint actions ────────────────────────────────────────────

  /**
   * HC targets are unsigned, finite, and capped at `Number.MAX_SAFE_INTEGER`
   * because the global HC counter is itself a JS number (REQ §7.3). A
   * target past safe-int could never match — better to reject at the
   * boundary than silently store a never-firing BP.
   */
  function assertHcTarget(n: number, label: string): void {
    if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `${label}: non-negative integer ≤ Number.MAX_SAFE_INTEGER required: ${n}`,
      );
    }
  }

  // Push the current full list to the loop and persist. Single helper
  // so every mutation site has the same side-effect tail and we keep
  // store ↔ loop ↔ backend in sync.
  function syncBreakpoints(): void {
    const snapshot = unwrap(breakpoints);
    loop.setBreakpoints(snapshot);
    void backend.saveBreakpoints(snapshot.map((b) => ({ ...b })));
  }

  function addBreakpoint(input: NewBreakpoint): void {
    if (input.kind === "pc-range") {
      assertAddr16(input.lo, "addBreakpoint lo");
      assertAddr16(input.hi, "addBreakpoint hi");
      if (input.lo > input.hi) {
        throw new RangeError(
          `addBreakpoint: lo (${input.lo}) must be ≤ hi (${input.hi})`,
        );
      }
    } else {
      assertHcTarget(input.target, "addBreakpoint target");
    }
    const id = shortId();
    const bp: Breakpoint =
      input.kind === "pc-range"
        ? {
            id,
            kind: "pc-range",
            lo: input.lo,
            hi: input.hi,
            enabled: input.enabled !== false,
          }
        : {
            id,
            kind: "hc-count",
            target: input.target,
            enabled: input.enabled !== false,
          };
    setBreakpoints(produce((arr) => arr.push(bp)));
    syncBreakpoints();
  }

  function removeBreakpoint(id: string): void {
    const idx = breakpoints.findIndex((b) => b.id === id);
    if (idx < 0) return;
    setBreakpoints(produce((arr) => arr.splice(idx, 1)));
    syncBreakpoints();
  }

  function toggleBreakpoint(id: string): void {
    const idx = breakpoints.findIndex((b) => b.id === id);
    if (idx < 0) return;
    setBreakpoints(idx, "enabled", (e) => !e);
    syncBreakpoints();
  }

  function editBreakpoint(id: string, patch: BreakpointPatch): void {
    const idx = breakpoints.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const current = breakpoints[idx];
    let changed = false;
    if (current.kind === "pc-range") {
      // Only lo/hi apply; target is silently ignored if passed.
      let nextLo = current.lo;
      let nextHi = current.hi;
      if (patch.lo !== undefined) {
        assertAddr16(patch.lo, "editBreakpoint lo");
        nextLo = patch.lo;
      }
      if (patch.hi !== undefined) {
        assertAddr16(patch.hi, "editBreakpoint hi");
        nextHi = patch.hi;
      }
      if (nextLo > nextHi) {
        throw new RangeError(
          `editBreakpoint: lo (${nextLo}) must be ≤ hi (${nextHi})`,
        );
      }
      if (nextLo !== current.lo || nextHi !== current.hi) {
        setBreakpoints(idx, { lo: nextLo, hi: nextHi });
        changed = true;
      }
    } else {
      if (patch.target !== undefined && patch.target !== current.target) {
        assertHcTarget(patch.target, "editBreakpoint target");
        // Object-form setter sidesteps the discriminated-union narrowing
        // limitation Solid's path setter hits on per-key writes.
        setBreakpoints(idx, { target: patch.target });
        changed = true;
      } else if (patch.target !== undefined) {
        // Validate even when equal so callers get a consistent error
        // surface — but skip the write + sync.
        assertHcTarget(patch.target, "editBreakpoint target");
      }
    }
    // Skip the loop push + backend write when nothing actually changed.
    // With IndexedDB (M10) this avoids a round-trip on every blur.
    if (changed) syncBreakpoints();
  }

  // Boot autoload — once the store is built, fire any autoload-flagged
  // files into memory so the user lands on a primed system at boot.
  loadAutoloadFiles();
  // Then arm BPs against the freshly-prepared system. Order matters
  // only logically: the CPU is paused at hc=0 through boot, so no BP
  // could have fired during autoload anyway — but doing it after
  // autoload reads cleanly as "system is ready, now subscribe."
  loop.setBreakpoints(unwrap(breakpoints));

  return {
    sections,
    toggleSectionFold,
    reorderSections,
    updateSectionConfig,
    status,
    isPaused,
    hc,
    insnCount,
    insnCountThrottled,
    lastPauseReason,
    effectiveClockMHz: effClockMHz,
    cpuState,
    prevCpuStateAtBoundary,
    atInstructionBoundary,
    run() {
      // Clear stale pause reason so the next paused-state render shows
      // the reason for the upcoming pause, not the previous one.
      setLastPauseReason(null);
      // Reseed the effective-clock baseline (REQ §11) so the first frame of
      // this run measures against run-start, not the last tick before the
      // (possibly long) pause.
      clockBaseHc = loop.hc();
      clockBaseNow = now();
      clockBaselined = true;
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
      // Effective-clock indicator resets (REQ §11): the HC rebase
      // invalidates any in-flight measurement; show "—" until the next run.
      setEffClockMHz(null);
      clockBaselined = false;
      // Time-stamped buffers clear on zero-HC (REQ §7.3). HW-trace was
      // a placeholder in M6; from M8a onward it shares the same clear
      // path as the instruction-trace ring. Snapshot log lands in M9.
      traceRing.clear();
      setTraceRingVersion((v) => v + 1);
      hwTrace.clear();
      lastSeenHwTraceVersion = hwTrace.version();
      setHwTraceVersion(lastSeenHwTraceVersion);
      // zeroHC is paused-only (gated by the Breakpoints header), so
      // the throttle bypass would fire anyway — still, be explicit.
      // Drops both the trace-ring throttle AND insnCountThrottled to
      // 0 in one shot.
      flushRunState();
      // Cursors snap back to live — anchor HCs would no longer mean
      // anything against the rebased counter.
      setCursors(
        produce((s) => {
          s.instructionTrace = { mode: "live" };
          s.hwTrace = { mode: "live" };
        }),
      );
    },
    coldBoot() {
      // Paused-only — reloading mid-run would yank an active CPU out
      // from under the user. TODO(REQ §7.4 / M8c): save-or-skip modal
      // when snapshot / HW-trace buffers exist.
      if (!isPaused()) return;
      window.location.reload();
    },
    hwTrace,
    hwTraceVersion,
    hwTraceMode,
    setHwTraceMode(mode: "disabled" | "ring") {
      if (mode !== "disabled" && mode !== "ring") {
        throw new RangeError(
          `setHwTraceMode: 'disabled' | 'ring' required, got ${mode}`,
        );
      }
      hwTrace.setMode(mode);
      if (mode === "disabled") {
        // Disabling capture discards the live ring. If it holds anything,
        // this is where a "save this trace first?" modal will hook in
        // before we zero it (M8c: VCD export). Placeholder until then —
        // for now we drop straight through to the clear.
        if (!hwTrace.isEmpty()) {
          // TODO(M8c): prompt to save/export the captured ring here, and
          // only clear on the user's confirm/discard.
        }
        // Zero the ring (head/tail reset) so the display shows nothing
        // rather than carrying a stale level across a window that a later
        // run advances past — the "dead lines" bug.
        hwTrace.clear();
        // A detached anchor HC is meaningless against an emptied ring.
        setCursors(
          produce((s) => {
            s.hwTrace = { mode: "live" };
          }),
        );
      }
      setHwTraceModeSig(mode);
      // setMode/clear bump the buffer's version; bring the reactive mirror
      // along immediately so consumers see the mode flip and the cleared
      // buffer without waiting for the next tick.
      lastSeenHwTraceVersion = hwTrace.version();
      setHwTraceVersion(lastSeenHwTraceVersion);
    },
    traceRing,
    traceRingVersion,
    traceRingVersionThrottled,
    cursors,
    detachInstructionTraceCursor(anchorHc: number) {
      // `produce` replaces the slice wholesale; plain
      // `setCursors("instructionTrace", obj)` would deep-merge and
      // leave a stale `anchorHc` after a live→detached→live cycle.
      setCursors(
        produce((s) => {
          s.instructionTrace = { mode: "detached", anchorHc };
        }),
      );
    },
    snapInstructionTraceCursorToLive() {
      setCursors(
        produce((s) => {
          s.instructionTrace = { mode: "live" };
        }),
      );
    },
    detachHwTraceCursor(anchorHc: number) {
      // Same `produce` wholesale-replace pattern as the instruction-trace
      // cursor — a plain path write would deep-merge and leave a stale
      // `anchorHc` after a live→detached→live cycle.
      setCursors(
        produce((s) => {
          s.hwTrace = { mode: "detached", anchorHc };
        }),
      );
    },
    snapHwTraceCursorToLive() {
      setCursors(
        produce((s) => {
          s.hwTrace = { mode: "live" };
        }),
      );
    },
    memByte(addr: number) {
      // Track the version signal so consumers' createMemo re-runs after
      // writes. The `& 0xffff` mask folds reads past 0xFFFF back into
      // the 64K window — matches the CPU's PC wrap and lets the disasm
      // preview cross the end of address space without a special case.
      memVersion();
      return bus.mem[addr & 0xffff];
    },
    memVersion,
    setMemByte(addr: number, value: number) {
      // Paused-only per REQ §6.6. Calls during run silently no-op —
      // matches the input's `disabled` state in the UI.
      if (status() !== "paused") return;
      assertAddr16(addr, "setMemByte");
      assertByte(value, "setMemByte value");
      bus.mem[addr] = value;
      bumpMemVersion();
    },
    ioByte(addr: number) {
      ioVersion();
      // Always the RD plane — that's the user-editable, IN-serviced
      // plane in both joined and split modes (REQ §11).
      return bus.ioRead[addr & 0xffff];
    },
    ioVersion,
    setIoByte(addr: number, value: number) {
      // Paused-only per REQ §6.7. Same gate as setMemByte.
      if (status() !== "paused") return;
      assertAddr16(addr, "setIoByte");
      assertByte(value, "setIoByte value");
      bus.ioRead[addr] = value;
      bumpIoVersion();
    },
    ioByteWrite(addr: number) {
      ioVersionWrite();
      // In joined mode the WR plane isn't allocated; the WR pane is
      // hidden, but a stray read still has to return something — 0 is
      // the simplest sentinel and the section gates on `splitIo()`
      // before subscribing anyway.
      const w = bus.ioWrite;
      return w ? w[addr & 0xffff] : 0;
    },
    ioVersionWrite,
    setIoBytePort8(port: number, value: number) {
      // Paused-only — same gate as setIoByte. `port` is an 8-bit value
      // (0..0xff); the bus handles the mask + broadcast across the
      // 256 high-byte aliases. UI version bump fires once for the
      // whole broadcast, not per alias.
      if (status() !== "paused") return;
      if (!Number.isInteger(port) || port < 0 || port > 0xff) {
        throw new RangeError(
          `setIoBytePort8 port: 0..0xFF required, got ${port}`,
        );
      }
      assertByte(value, "setIoBytePort8 value");
      bus.broadcastIoLowByte(port, value);
      bumpIoVersion();
    },
    lastMemRead,
    lastMemWrite,
    lastIoRead,
    lastIoWrite,
    memWatchAddr,
    setMemWatchAddr(addr: number) {
      assertAddr16(addr, "setMemWatchAddr");
      updateSectionConfig("memory", { watchAddr: addr });
    },
    memWatchJumpVersion,
    requestMemWatchJump() {
      setMemWatchJumpVersion((v) => v + 1);
    },
    ioWatchAddr,
    setIoWatchAddr(addr: number) {
      assertAddr16(addr, "setIoWatchAddr");
      updateSectionConfig("io", { watchAddr: addr });
    },
    ioWatchJumpVersion,
    requestIoWatchJump() {
      setIoWatchJumpVersion((v) => v + 1);
    },
    ioWatchAddrWrite,
    setIoWatchAddrWrite(addr: number) {
      assertAddr16(addr, "setIoWatchAddrWrite");
      updateSectionConfig("io", { watchAddrWrite: addr });
    },
    ioWatchJumpVersionWrite,
    requestIoWatchJumpWrite() {
      setIoWatchJumpVersionWrite((v) => v + 1);
    },
    memBytesPerRow,
    setMemBytesPerRow(n: number) {
      assertBytesPerRow(n, MEMORY_BYTES_PER_ROW_OPTIONS, "setMemBytesPerRow");
      updateSectionConfig("memory", { bytesPerRow: n });
    },
    ioBytesPerRow,
    setIoBytesPerRow(n: number) {
      assertBytesPerRow(n, IO_BYTES_PER_ROW_OPTIONS, "setIoBytesPerRow");
      updateSectionConfig("io", { bytesPerRow: n });
    },
    ioViewMode,
    setIoViewMode(mode: "16bit" | "8bit") {
      if (mode !== "16bit" && mode !== "8bit") {
        throw new RangeError(
          `setIoViewMode: '16bit' | '8bit' required, got ${mode}`,
        );
      }
      // Switching to 8-bit mode masks the persisted watch addresses to
      // the low byte — the 8-bit view's address space is 0..0xFF, so a
      // stale 16-bit value (4080) would be unreachable. Both RD and WR
      // watch fields are masked in a single config write so reload
      // restores them atomically.
      if (mode === "8bit") {
        const patch: Record<string, unknown> = { viewMode: mode };
        const wa = ioWatchAddr();
        if (wa > 0xff) patch.watchAddr = wa & 0xff;
        const waw = ioWatchAddrWrite();
        if (waw > 0xff) patch.watchAddrWrite = waw & 0xff;
        updateSectionConfig("io", patch);
        return;
      }
      updateSectionConfig("io", { viewMode: mode });
    },
    splitIo,
    pendingSplitIo,
    setPendingSplitIo: (on: boolean) => setPendingSplitIo(on),
    splitIoDirty,
    setSplitIo(on: boolean) {
      // Paused-only — toggling the IO layout mid-run could leave OUT
      // cycles split across modes. We bypass the usual updateSectionConfig
      // path (which fires its own fire-and-forget persistUi) because we
      // need a single save whose resolution gates the page reload, plus
      // a catch hook that rolls back the in-memory flip if persistence
      // fails — otherwise the UI would render the new mode while the
      // bus (unchanged until reload) stays in the old one.
      if (!isPaused()) return;
      const v = on === true;
      const prev = splitIo();
      if (v === prev) return;
      const idx = sections.findIndex((s) => s.id === "io");
      if (idx < 0) return;
      setSections(idx, "config", (cfg) => ({ ...cfg, splitIo: v }));
      const state: UiState = {
        sections: unwrap(sections),
        fileOrder: files.map((f) => f.id),
        uiConfig: uiConfig(),
      };
      backend.saveUiState(state).then(
        () => {
          // Page reload is the allocation event: on boot, the bus reads
          // the persisted `splitIo` flag and either skips or allocates
          // the WR plane. Matches the existing Reinit semantics in
          // sections/breakpoints/index.tsx (REQ §7.3).
          window.location.reload();
        },
        (err: unknown) => {
          // Roll the UI back so it matches the bus that the user still
          // has. Without this the checkbox would stay flipped while
          // OUT cycles continue to land in the original plane. Also
          // resync pendingSplitIo — otherwise the App-shell would lock
          // the user with a checkbox stuck on the failed target value
          // and no way to know the persist failed (REQ §11 staging
          // dirty-lock).
          console.error("setSplitIo: persistence failed; reverting", err);
          setSections(idx, "config", (cfg) => ({ ...cfg, splitIo: prev }));
          setPendingSplitIo(prev);
        },
      );
    },
    inputPins,
    setInputPin(name, value) {
      // Paused-only per REQ §7.5. Same gate as setMemByte/setIoByte —
      // the UI's checkbox is `disabled={!isPaused()}`, this enforces
      // the same contract for programmatic callers.
      if (status() !== "paused") return;
      // Bus is authoritative; mirror into the UI store so the
      // HW-trace checkbox + folded summary re-render. Bus masks at
      // its boundary; we re-read after the write so the mirror
      // reflects what the bus actually stored.
      bus.setInputPin(name, value);
      setInputPins(name, bus.getInputPin(name));
    },
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
    breakpoints,
    addBreakpoint,
    removeBreakpoint,
    toggleBreakpoint,
    editBreakpoint,
    uiConfig,
    setUiConfig,
    dispose() {
      disposed = true;
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
