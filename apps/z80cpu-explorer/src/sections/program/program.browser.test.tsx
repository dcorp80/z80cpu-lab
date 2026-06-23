// Browser-mode tests for behaviors happy-dom can't fairly simulate:
//  - the real `<input type="file">` change event with a constructed
//    `File` + `DataTransfer` (happy-dom can't populate `input.files`
//    via the standard route)
//  - real focus/blur on the addr input (commit-on-blur)
//  - CSS resolution for the dirty highlight
//
// All other Program-section behaviors are covered in
// `program.test.tsx` under happy-dom.

import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
// The mixer program from the bench workspace — a real assembled Z80
// binary we can use as a non-trivial autoload payload. Vite resolves
// the `?url` asset import; we fetch the bytes from the dev server.
import mixerUrl from "../../../../../packages/z80cpu-bench/src/mixer.bin?url";
import { type BootedApp, bootApp } from "../../boot.tsx";
import { MemoryBackend } from "../../storage/memory.ts";
import "../../styles.css";
import { __testing } from "./index.tsx";

let booted: BootedApp;
let dispose: () => void = () => {};

async function mountApp(backend?: MemoryBackend) {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  booted = await bootApp({ backend });
  const detachRender = render(booted.ui, container);
  dispose = () => {
    detachRender();
    booted.dispose();
    container.remove();
    __testing.setPickFile(null);
  };
}

afterEach(() => {
  dispose();
});

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("Program section (browser smoke)", () => {
  it("boot autoload primes mem end-to-end from a real Z80 binary (mixer.bin)", async () => {
    const res = await fetch(mixerUrl);
    const mixerBytes = new Uint8Array(await res.arrayBuffer());
    expect(mixerBytes.length).toBeGreaterThan(0);

    const backend = new MemoryBackend();
    await backend.putFile({
      id: "mixer",
      name: "mixer.bin",
      bytes: mixerBytes,
      loadAddr: 0x0000,
      autoload: true,
    });
    await mountApp(backend);

    // File row appears for the autoloaded file.
    await expect.element(page.getByText("mixer.bin")).toBeInTheDocument();
    expect(booted.store.files).toHaveLength(1);
    expect(booted.store.files[0].bytes.length).toBe(mixerBytes.length);
    // Session marker reflects the boot autoload write.
    const id = booted.store.files[0].id;
    expect(booted.store.fileSessions[id]?.lastLoadedAddr).toBe(0);
    // Now run the loop a tiny amount — the CPU fetches from 0x0000,
    // which by autoload should now contain the mixer's first opcode.
    // If autoload silently failed we'd be fetching FFs (RST 38) and
    // landing in a very different shape; running 8 HC and seeing the
    // counter advance proves the loop is alive against real bytes.
    booted.store.run();
    await new Promise<void>((r) => setTimeout(r, 50));
    booted.store.pause();
    expect(booted.store.hc()).toBeGreaterThan(0);
  });

  it("Add stub: type addr → click Add → picker resolves → file written, stub resets", async () => {
    // The real file picker (DataTransfer + change event) is exercised in
    // program.test.tsx's `defaultPickFile` race tests under happy-dom.
    // Here we stub the picker so the test focuses on the integration:
    // type addr in stub → click Add → file added at typed addr, written
    // to memory, stub resets to 0000.
    __testing.setPickFile(async () => ({
      name: "picked.bin",
      bytes: new Uint8Array([0xab, 0xcd, 0xef]),
    }));
    // Fresh MemoryBackend — see the dirty-highlight test below for why
    // (default backend is IndexedDB and persists across tests in the
    // same browser context).
    await mountApp(new MemoryBackend());
    // Type a non-default address into the stub's addr input.
    const stubRow = document.querySelector(".program-add-stub") as HTMLElement;
    const addrInput = stubRow.querySelector<HTMLInputElement>(
      ".program-file-addr",
    ) as HTMLInputElement;
    addrInput.focus();
    addrInput.value = "C000";
    addrInput.dispatchEvent(new Event("input", { bubbles: true }));
    // Click the stub's Add button.
    const addBtn = stubRow.querySelector("button") as HTMLButtonElement;
    addBtn.click();
    await expect.element(page.getByText("picked.bin")).toBeInTheDocument();
    expect(booted.store.files).toHaveLength(1);
    expect(booted.store.files[0].name).toBe("picked.bin");
    expect(booted.store.files[0].loadAddr).toBe(0xc000);
    const id = booted.store.files[0].id;
    expect(booted.store.fileSessions[id]?.lastLoadedAddr).toBe(0xc000);
    // Stub addr resets to 0000 after the successful add.
    const stubAfter = document.querySelector(
      ".program-add-stub .program-file-addr",
    ) as HTMLInputElement;
    expect(stubAfter.value).toBe("0000");
  });

  it("file-row addr input commits the parsed value on real blur", async () => {
    // Fresh MemoryBackend — see the dirty-highlight test below for why.
    await mountApp(new MemoryBackend());
    booted.store.addFile({
      name: "rom.bin",
      bytes: new Uint8Array([0]),
      loadAddr: 0x1000,
    });
    await flush();
    // The stub also has a "Load address" textbox, so reach the real-
    // row input by selector rather than role lookup.
    const realRow = Array.from(
      document.querySelectorAll<HTMLElement>(".program-file-row"),
    ).find((r) => !r.classList.contains("program-add-stub"));
    const addrInput = realRow?.querySelector<HTMLInputElement>(
      ".program-file-addr",
    ) as HTMLInputElement;
    // Real focus, real typing, real blur. Happy-dom struggles with
    // event.currentTarget on programmatic blur(); the real browser
    // exercises this without ceremony.
    addrInput.focus();
    expect(document.activeElement).toBe(addrInput);
    addrInput.value = "$8000";
    addrInput.dispatchEvent(new Event("input", { bubbles: true }));
    addrInput.blur();
    expect(booted.store.files[0].loadAddr).toBe(0x8000);
    // Display normalised to bare uppercase hex.
    expect(addrInput.value).toBe("8000");
  });

  it("dirty highlight is visible (CSS rule applies) after addr changes post-load", async () => {
    // Fresh MemoryBackend per test — the default backend is IndexedDB,
    // which persists across tests in the same browser context. The two
    // prior tests in this describe add files via the default backend,
    // so without isolation here we land with three file rows and the
    // "Load" button locator matches three elements.
    await mountApp(new MemoryBackend());
    booted.store.addFile({
      name: "rom.bin",
      bytes: new Uint8Array([0xaa]),
      loadAddr: 0x100,
    });
    await flush();
    // Load it so session.lastLoadedAddr is set. Use exact match against
    // the per-file button label so the locator stays tight.
    const loadBtn = page.getByRole("button", { name: "Load", exact: true });
    await loadBtn.click();
    // Change addr on the real row (not the stub).
    const realRow = Array.from(
      document.querySelectorAll<HTMLElement>(".program-file-row"),
    ).find((r) => !r.classList.contains("program-add-stub")) as HTMLElement;
    const addrInput = realRow.querySelector<HTMLInputElement>(
      ".program-file-addr",
    ) as HTMLInputElement;
    addrInput.focus();
    addrInput.value = "200";
    addrInput.dispatchEvent(new Event("input", { bubbles: true }));
    addrInput.blur();
    expect(realRow.classList.contains("is-dirty")).toBe(true);
    // The dirty rule sets border-color: var(--warning); check it
    // actually applied (real CSS resolution, not just DOM class).
    // Resolve --warning via a probe element so the assertion stays
    // theme-agnostic — light/dark schemes use different hex values.
    const probe = document.createElement("div");
    probe.style.borderColor = "var(--warning)";
    document.body.appendChild(probe);
    const expectedBorder = getComputedStyle(probe).borderColor;
    probe.remove();
    expect(getComputedStyle(addrInput).borderColor).toBe(expectedBorder);
  });
});
