// Happy-dom render tests for the App-shell section (REQ §11).
// Covers: Cold boot button wiring, Split RD/WR pending/dirty/save/discard
// flow, fold-lock behavior, default-folded on a fresh boot.

import { fireEvent } from "@solidjs/testing-library";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../storage/memory.ts";
import {
  createAppStore,
  type Store,
  StoreProvider,
} from "../../store/index.ts";
import { makeStubBus } from "../../store/testStubBus.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop, type StubLoop } from "../../store/testStubLoop.ts";
import { STR } from "../../style/strings.ts";
import { SectionFrame } from "../frame.tsx";
import { appShell } from "./index.tsx";

interface Harness {
  container: HTMLElement;
  store: Store;
  loop: StubLoop;
  dispose: () => void;
}

async function mount(slot: "header" | "body" | "frame"): Promise<Harness> {
  const backend = new MemoryBackend();
  const loop = makeStubLoop();
  const bus = makeStubBus();
  const dbg = makeStubDbg();
  const store = await createAppStore({ backend, loop, bus, dbg });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const ui =
    slot === "frame"
      ? () => (
          <StoreProvider value={store}>
            <SectionFrame
              id="appShell"
              folded={
                store.sections.find((s) => s.id === "appShell")?.folded ?? false
              }
            />
          </StoreProvider>
        )
      : slot === "header"
        ? () => (
            <StoreProvider value={store}>
              <appShell.Header />
            </StoreProvider>
          )
        : () => (
            <StoreProvider value={store}>
              <appShell.Body />
            </StoreProvider>
          );
  const dispose = render(ui, container);
  return {
    container,
    store,
    loop,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("appShell — defaults", () => {
  it("section is folded on a fresh boot (REQ §11 'collapsed by default')", async () => {
    const backend = new MemoryBackend();
    const loop = makeStubLoop();
    const bus = makeStubBus();
    const dbg = makeStubDbg();
    const store = await createAppStore({ backend, loop, bus, dbg });
    const s = store.sections.find((sec) => sec.id === "appShell");
    expect(s).toBeDefined();
    expect(s?.folded).toBe(true);
  });

  it("appears as the topmost section in the registry order", async () => {
    const backend = new MemoryBackend();
    const loop = makeStubLoop();
    const bus = makeStubBus();
    const dbg = makeStubDbg();
    const store = await createAppStore({ backend, loop, bus, dbg });
    expect(store.sections[0]?.id).toBe("appShell");
  });
});

describe("appShell — Cold boot button (header)", () => {
  it("renders with the app name as the section title and a Cold boot button", async () => {
    harness = await mount("header");
    const btn =
      harness.container.querySelector<HTMLButtonElement>(".appshell-coldboot");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe(STR.appShell.coldBoot);
  });

  it("renders the version chip with v<version> (<sha>)", async () => {
    harness = await mount("header");
    const chip =
      harness.container.querySelector<HTMLSpanElement>(".appshell-version");
    expect(chip).not.toBeNull();
    // __APP_VERSION__ / __BUILD_SHA__ are injected by Vite's `define` and
    // apply in vitest too, so the chip's text matches the STR formatter.
    expect(chip?.textContent).toBe(
      STR.appShell.version(__APP_VERSION__, __BUILD_SHA__),
    );
  });

  it("disables the Cold boot button while the CPU is running", async () => {
    harness = await mount("header");
    const btn =
      harness.container.querySelector<HTMLButtonElement>(".appshell-coldboot");
    if (!btn) throw new Error("cold-boot button");
    expect(btn.disabled).toBe(false);
    harness.store.run();
    await flush();
    expect(btn.disabled).toBe(true);
  });

  it("Cold boot click reloads the page (happy-dom location.reload stub)", async () => {
    harness = await mount("header");
    const reload = vi.fn();
    const original = window.location.reload;
    // happy-dom's `location.reload` is configurable. Save the original
    // first so the after-test restore doesn't bleed this spy into the
    // next test in the worker (Save's reload path would otherwise hit
    // this fn and skip the real reload).
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: reload,
    });
    try {
      const btn =
        harness.container.querySelector<HTMLButtonElement>(
          ".appshell-coldboot",
        );
      btn?.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.location, "reload", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("appShell — Split RD/WR dirty/save/discard (body)", () => {
  it("toggling the checkbox stages a pending value without flipping live splitIo", async () => {
    harness = await mount("body");
    const cb = harness.container.querySelector<HTMLInputElement>(
      ".appshell-split-checkbox",
    );
    if (!cb) throw new Error("split checkbox");
    expect(cb.checked).toBe(false); // stub bus defaults to joined
    expect(harness.store.splitIoDirty()).toBe(false);
    fireEvent.click(cb);
    expect(harness.store.pendingSplitIo()).toBe(true);
    expect(harness.store.splitIo()).toBe(false); // live unchanged
    expect(harness.store.splitIoDirty()).toBe(true);
  });

  it("Save/Discard row only appears when dirty", async () => {
    harness = await mount("body");
    expect(harness.container.querySelector(".appshell-actions")).toBeNull();
    const cb = harness.container.querySelector<HTMLInputElement>(
      ".appshell-split-checkbox",
    );
    fireEvent.click(cb as HTMLInputElement);
    expect(harness.container.querySelector(".appshell-actions")).not.toBeNull();
  });

  it("Discard reverts pending to live and hides the actions row", async () => {
    harness = await mount("body");
    const cb = harness.container.querySelector<HTMLInputElement>(
      ".appshell-split-checkbox",
    );
    fireEvent.click(cb as HTMLInputElement);
    expect(harness.store.splitIoDirty()).toBe(true);
    const discard =
      harness.container.querySelector<HTMLButtonElement>(".appshell-discard");
    discard?.click();
    expect(harness.store.pendingSplitIo()).toBe(false);
    expect(harness.store.splitIoDirty()).toBe(false);
    expect(harness.container.querySelector(".appshell-actions")).toBeNull();
  });

  it("Save calls commitReloadSettings (reload-triggering happens inside)", async () => {
    harness = await mount("body");
    // Stub the real implementation so the click doesn't trigger a
    // backend persist + `window.location.reload()` mid-test. We're only
    // asserting Save's wiring here; persist + reload behavior is covered
    // by the store-level tests in `store/index.test.ts`.
    const spy = vi
      .spyOn(harness.store, "commitReloadSettings")
      .mockImplementation(() => {});
    const cb = harness.container.querySelector<HTMLInputElement>(
      ".appshell-split-checkbox",
    );
    fireEvent.click(cb as HTMLInputElement);
    const save =
      harness.container.querySelector<HTMLButtonElement>(".appshell-save");
    save?.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("appShell — reload-required fill bytes (body)", () => {
  it("Memory and IO fill inputs render with the current live bytes (default FF)", async () => {
    harness = await mount("body");
    const memInput =
      harness.container.querySelector<HTMLInputElement>("#appshell-mem-init");
    const ioInput =
      harness.container.querySelector<HTMLInputElement>("#appshell-io-init");
    if (!memInput || !ioInput) throw new Error("fill inputs");
    // Stub bus's default fill is 0xFF; rendered as "FF" via the 2-pad
    // hex formatter.
    expect(memInput.value.toUpperCase()).toBe("FF");
    expect(ioInput.value.toUpperCase()).toBe("FF");
    // Live + pending start equal — nothing dirty, no actions row.
    expect(harness.store.memInitDirty()).toBe(false);
    expect(harness.store.ioInitDirty()).toBe(false);
    expect(harness.store.reloadSettingsDirty()).toBe(false);
    expect(harness.container.querySelector(".appshell-actions")).toBeNull();
  });

  it("editing Memory fill stages pendingMemInit without touching live (mirrors splitIo)", async () => {
    harness = await mount("body");
    const memInput =
      harness.container.querySelector<HTMLInputElement>("#appshell-mem-init");
    if (!memInput) throw new Error("mem-init input");
    // Type a new value and Enter to commit through HexAddrInput.
    memInput.focus();
    fireEvent.input(memInput, { target: { value: "00" } });
    fireEvent.keyDown(memInput, { key: "Enter" });
    expect(harness.store.pendingMemInit()).toBe(0x00);
    expect(harness.store.memInit()).toBe(0xff); // live still default
    expect(harness.store.memInitDirty()).toBe(true);
    expect(harness.store.reloadSettingsDirty()).toBe(true);
    // The actions row appears once any reload-required setting is dirty.
    expect(harness.container.querySelector(".appshell-actions")).not.toBeNull();
  });

  it("Discard reverts every pending (mem + IO + split) in one click", async () => {
    harness = await mount("body");
    harness.store.setPendingMemInit(0x00);
    harness.store.setPendingIoInit(0x55);
    harness.store.setPendingSplitIo(!harness.store.splitIo());
    await flush();
    expect(harness.store.reloadSettingsDirty()).toBe(true);
    const discard =
      harness.container.querySelector<HTMLButtonElement>(".appshell-discard");
    discard?.click();
    expect(harness.store.pendingMemInit()).toBe(harness.store.memInit());
    expect(harness.store.pendingIoInit()).toBe(harness.store.ioInit());
    expect(harness.store.pendingSplitIo()).toBe(harness.store.splitIo());
    expect(harness.store.reloadSettingsDirty()).toBe(false);
  });

  it("Save with mixed dirty settings calls commitReloadSettings once", async () => {
    harness = await mount("body");
    const spy = vi
      .spyOn(harness.store, "commitReloadSettings")
      .mockImplementation(() => {});
    harness.store.setPendingMemInit(0x00);
    harness.store.setPendingIoInit(0x55);
    await flush();
    const save =
      harness.container.querySelector<HTMLButtonElement>(".appshell-save");
    save?.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("appShell — fold-lock (frame)", () => {
  it("chevron disables while unfolded+dirty; stays enabled while folded+dirty so the user can reach Save/Discard", async () => {
    harness = await mount("frame");
    const chevron =
      harness.container.querySelector<HTMLButtonElement>(".fold-chevron");
    if (!chevron) throw new Error("chevron");
    // Default state: folded, clean. Chevron is enabled.
    expect(
      harness.store.sections.find((s) => s.id === "appShell")?.folded,
    ).toBe(true);
    expect(chevron.disabled).toBe(false);
    // Stage a dirty value while folded. Chevron must STAY enabled —
    // otherwise a persist failure that left the section folded+dirty
    // would trap the user (Save/Discard live in the unmounted Body).
    harness.store.setPendingSplitIo(true);
    await flush();
    expect(harness.store.splitIoDirty()).toBe(true);
    expect(chevron.disabled).toBe(false);
    // Unfold while still dirty — now the chevron locks (cannot collapse
    // and lose access to Save/Discard).
    harness.store.toggleSectionFold("appShell");
    await flush();
    expect(chevron.disabled).toBe(true);
    // Discard releases the lock.
    harness.store.setPendingSplitIo(false);
    await flush();
    expect(chevron.disabled).toBe(false);
  });

  it("clicking the locked chevron is a no-op (cannot collapse while unfolded+dirty)", async () => {
    harness = await mount("frame");
    // Default starts folded; unfold first so we can prove the lock keeps
    // the body open.
    harness.store.toggleSectionFold("appShell");
    await flush();
    expect(
      harness.store.sections.find((s) => s.id === "appShell")?.folded,
    ).toBe(false);
    harness.store.setPendingSplitIo(true);
    await flush();
    const chevron =
      harness.container.querySelector<HTMLButtonElement>(".fold-chevron");
    chevron?.click();
    expect(
      harness.store.sections.find((s) => s.id === "appShell")?.folded,
    ).toBe(false);
  });

  it("after Discard the section auto-folds back to collapsed", async () => {
    harness = await mount("frame");
    // Unfold (default is folded).
    harness.store.toggleSectionFold("appShell");
    await flush();
    expect(
      harness.store.sections.find((s) => s.id === "appShell")?.folded,
    ).toBe(false);
    // Stage + discard via the Body's button — needs the body mounted.
    // The frame mounts the body when not folded; the discard button is
    // rendered when dirty.
    harness.store.setPendingSplitIo(true);
    await flush();
    const discard =
      harness.container.querySelector<HTMLButtonElement>(".appshell-discard");
    discard?.click();
    await flush();
    expect(
      harness.store.sections.find((s) => s.id === "appShell")?.folded,
    ).toBe(true);
  });

  it("after Save the section auto-folds back to collapsed (mirrors Discard)", async () => {
    harness = await mount("frame");
    // Stub commitReloadSettings so the Save click doesn't actually
    // trigger a page reload (which would also bypass the fold assertion).
    vi.spyOn(harness.store, "commitReloadSettings").mockImplementation(
      () => {},
    );
    // Unfold (default is folded), stage a dirty value, click Save.
    harness.store.toggleSectionFold("appShell");
    await flush();
    harness.store.setPendingSplitIo(true);
    await flush();
    const save =
      harness.container.querySelector<HTMLButtonElement>(".appshell-save");
    save?.click();
    await flush();
    // Folded again — without this, the persisted UiState would carry
    // folded=false from the user's expand, and reload would restore the
    // section open even though they're done with it.
    expect(
      harness.store.sections.find((s) => s.id === "appShell")?.folded,
    ).toBe(true);
  });
});
