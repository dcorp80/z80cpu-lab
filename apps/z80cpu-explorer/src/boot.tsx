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
import { DEFAULT_BUS_CONFIG, DEFAULT_LOOP_CONFIG } from "./config/defaults.ts";
import { registerDefaultHotkeys } from "./hotkeys/defaults.ts";
import { installHotkeyDispatcher } from "./hotkeys/dispatch.ts";
import { createHotkeyRegistry } from "./hotkeys/registry.ts";
import { makeBus64k } from "./runloop/bus.ts";
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

  const cpu = new Z80Cpu();
  const dbg = new Z80DebugContext(cpu);
  const bus = makeBus64k(cpu, { ...DEFAULT_BUS_CONFIG });

  const loop = createRunLoop({
    cpu,
    dbg,
    busTick: bus.resolve,
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
