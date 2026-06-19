// App boot: assemble cpu + dbg + bus + loop + store + hotkeys, return
// the renderable UI plus a `dispose` hook that tears down the document-
// level hotkey listener (and anything else stateful) on exit.
//
// Extracted from main.tsx so browser-mode tests can boot a fresh app
// per test without duplicating the wiring.

import { Z80Cpu } from "@dcorp80/z80cpu";
import { Z80DebugContext } from "@dcorp80/z80cpu-debug";
import type { JSX } from "solid-js";
import { App } from "./app.tsx";
import {
  DEFAULT_BUS_CONFIG,
  DEFAULT_HW_TRACE_CONFIG,
  DEFAULT_LOOP_CONFIG,
  isPersistedByte,
} from "./config/defaults.ts";
import { registerDefaultHotkeys } from "./hotkeys/defaults.ts";
import { installHotkeyDispatcher } from "./hotkeys/dispatch.ts";
import { createHotkeyRegistry } from "./hotkeys/registry.ts";
import { makeBus64k } from "./runloop/bus.ts";
import { HwTraceBuffer } from "./runloop/hwTrace.ts";
import { createRunLoop, type ReadonlyHcBox } from "./runloop/loop.ts";
import { openDefaultBackend } from "./storage/indexeddb.ts";
import type { StorageBackend } from "./storage/types.ts";
import { createAppStore, type Store, StoreProvider } from "./store/index.ts";

export interface BootOptions {
  /**
   * Override the storage backend; defaults to `openDefaultBackend()`
   * which returns `IndexedDbBackend` (with `MemoryBackend` fallback if
   * IDB is unavailable). Tests inject `MemoryBackend` directly.
   */
  backend?: StorageBackend;
}

export interface BootedApp {
  store: Store;
  /** Pass to Solid's `render(ui, container)`. */
  ui: () => JSX.Element;
  /** Tear-down hook — detaches the document-level hotkey listener. */
  dispose: () => void;
}

export async function bootApp(opts: BootOptions = {}): Promise<BootedApp> {
  const backend = opts.backend ?? (await openDefaultBackend());

  // Persistence is read once up-front so the bus's construction
  // (allocation + fill bytes) matches the user's
  // last committed Save, then handed to the store via `preloadedUi` so
  // `createAppStore` doesn't issue a second load. When nothing is
  // persisted (fresh boot, IDB-unavailable fallback, corrupt value),
  // each field falls back to its shipped `DEFAULT_BUS_CONFIG` value.
  const preloadedUi = await backend.loadUiState();
  const ioCfg = preloadedUi?.sections?.find((s) => s.id === "io")?.config;
  const memCfg = preloadedUi?.sections?.find((s) => s.id === "memory")?.config;
  const splitIo =
    typeof ioCfg?.splitIo === "boolean"
      ? ioCfg.splitIo
      : DEFAULT_BUS_CONFIG.splitIo;
  const memInit = isPersistedByte(memCfg?.memInit)
    ? memCfg.memInit
    : DEFAULT_BUS_CONFIG.memInit;
  const ioInit = isPersistedByte(ioCfg?.ioInit)
    ? ioCfg.ioInit
    : DEFAULT_BUS_CONFIG.ioInit;

  const cpu = new Z80Cpu();
  const dbg = new Z80DebugContext(cpu);
  const bus = makeBus64k(cpu, {
    ...DEFAULT_BUS_CONFIG,
    splitIo,
    memInit,
    ioInit,
  });
  const hwTrace = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);

  const preEdge = (): void => {
    bus.resolve();
  };
  const postEdge = (hcBox: ReadonlyHcBox): void => {
    // Record straight off the live bus — no intermediate sample. `record`
    // short-circuits before touching anything when capture is disabled
    //. `nNMI` is injected separately (it isn't on cpu.bus); the bus owns the pin level. After the record we
    // auto-clear nNMI so it reads as a 1-HC pulse in the trace
    // ([[feedback-nmi-pulse-semantics]]). The store's reactive mirror
    // re-syncs on the next `loop.onTick` so the checkbox UI returns to
    // unchecked.
    //
    // `hcBox` is forwarded by reference into `hwTrace.record` so the HC
    // stamp lands in `chunk.hcs[pos] = hcBox[0]` as a typed-array copy
    // — no HeapNumber materialization past V8's SMI range.
    const nNMI = bus.getInputPin("nNMI");
    hwTrace.record(cpu.bus, nNMI, hcBox);
    if (nNMI === 0) bus.setInputPin("nNMI", 1);
  };

  const loop = createRunLoop({
    cpu,
    dbg,
    preEdge,
    postEdge,
    config: { ...DEFAULT_LOOP_CONFIG },
  });

  const store = await createAppStore({
    backend,
    loop,
    // Store closes over bus.mem for `writeFileToMemory` (file load) and
    // over `setIntVector`/`intVector` for the INT-vector UI mirror.
    // Not on the public Store interface — sections see only signals
    // and verbs.
    bus,
    // dbg is the snapshot source for the cpuState section's reactive
    // accessors; store calls `dbg.state()` on each pause.
    dbg,
    hwTrace,
    preloadedUi,
  });

  const registry = createHotkeyRegistry();
  registerDefaultHotkeys(registry, store);
  const detachHotkeys = installHotkeyDispatcher(registry);

  const ui = (): JSX.Element => (
    <StoreProvider value={store}>
      <App />
    </StoreProvider>
  );

  return {
    store,
    ui,
    dispose() {
      detachHotkeys();
      loop.pause();
      store.dispose();
    },
  };
}
