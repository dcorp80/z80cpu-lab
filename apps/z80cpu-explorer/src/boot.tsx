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
} from "./config/defaults.ts";
import { registerDefaultHotkeys } from "./hotkeys/defaults.ts";
import { installHotkeyDispatcher } from "./hotkeys/dispatch.ts";
import { createHotkeyRegistry } from "./hotkeys/registry.ts";
import { makeBus64k } from "./runloop/bus.ts";
import { HwTraceBuffer } from "./runloop/hwTrace.ts";
import { createRunLoop } from "./runloop/loop.ts";
import { MemoryBackend } from "./storage/memory.ts";
import type { StorageBackend } from "./storage/types.ts";
import { createAppStore, type Store, StoreProvider } from "./store/index.ts";

export interface BootOptions {
  /** Override the storage backend; defaults to a fresh `MemoryBackend`. */
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
  const backend = opts.backend ?? new MemoryBackend();

  // Persistence is read once up-front so the bus's `splitIo` allocation
  // (REQ §11) matches the user's last toggle, then handed to the store
  // via `preloadedUi` so `createAppStore` doesn't issue a second load.
  // When nothing is persisted (fresh boot, MemoryBackend, corrupt value),
  // fall back to the shipped `DEFAULT_BUS_CONFIG.splitIo` — flipping
  // that default is the intended escape hatch for testing the split
  // mode before the IndexedDB backend lands (M10).
  const preloadedUi = await backend.loadUiState();
  const persistedSplitIo = preloadedUi?.sections?.find((s) => s.id === "io")
    ?.config?.splitIo;
  const splitIo =
    typeof persistedSplitIo === "boolean"
      ? persistedSplitIo
      : DEFAULT_BUS_CONFIG.splitIo;

  const cpu = new Z80Cpu();
  const dbg = new Z80DebugContext(cpu);
  const bus = makeBus64k(cpu, { ...DEFAULT_BUS_CONFIG, splitIo });
  const hwTrace = new HwTraceBuffer(DEFAULT_HW_TRACE_CONFIG);

  const preEdge = (): void => {
    bus.resolve();
  };
  const postEdge = (hc: number): void => {
    // Record straight off the live bus — no intermediate sample. `record`
    // short-circuits before touching anything when capture is disabled
    // (DESIGN §3.2). `nNMI` is injected separately (it isn't on cpu.bus —
    // DESIGN §2.1); the bus owns the pin level. After the record we
    // auto-clear nNMI so it reads as a 1-HC pulse in the trace (REQ §6.4
    // / [[feedback-nmi-pulse-semantics]]). The store's reactive mirror
    // re-syncs on the next `loop.onTick` so the checkbox UI returns to
    // unchecked.
    const nNMI = bus.getInputPin("nNMI");
    hwTrace.record(cpu.bus, nNMI, hc);
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
    // and verbs (DESIGN §4 "Layering rule").
    bus,
    // dbg is the snapshot source for the cpuState section's reactive
    // accessors (REQ §6.5); store calls `dbg.state()` on each pause.
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
