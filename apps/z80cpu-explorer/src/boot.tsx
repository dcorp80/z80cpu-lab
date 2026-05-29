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
import { registerDefaultHotkeys } from "./hotkeys/defaults.ts";
import { installHotkeyDispatcher } from "./hotkeys/dispatch.ts";
import { createHotkeyRegistry } from "./hotkeys/registry.ts";
import { makeBus64k } from "./runloop/bus.ts";
import { DEFAULT_BUS_CONFIG, DEFAULT_LOOP_CONFIG } from "./runloop/defaults.ts";
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

  const store = await createAppStore({ backend, loop, bus });

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
    },
  };
}
