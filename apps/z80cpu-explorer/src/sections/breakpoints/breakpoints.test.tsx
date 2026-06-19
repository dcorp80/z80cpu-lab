// Happy-dom render tests for the Breakpoints section. Mirrors the
// Program section's harness pattern — real Solid store backed by an
// in-memory backend + stub loop/bus/dbg, with the section's Header,
// FoldedSummary, and Body slots mounted directly.

import { fireEvent } from "@solidjs/testing-library";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
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
import { buttonByText, flush, req } from "../../test/dom.ts";
import { breakpoints } from "./index.tsx";

interface Harness {
  store: Store;
  loop: StubLoop;
  container: HTMLElement;
  dispose: () => void;
}

async function mount(opts: { folded?: boolean } = {}): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const loop = makeStubLoop();
  const store = await createAppStore({
    backend: new MemoryBackend(),
    loop,
    bus: makeStubBus(),
    dbg: makeStubDbg(),
  });
  const ui = opts.folded
    ? () => (
        <StoreProvider value={store}>
          <breakpoints.Header />
          {breakpoints.FoldedSummary && <breakpoints.FoldedSummary />}
        </StoreProvider>
      )
    : () => (
        <StoreProvider value={store}>
          <breakpoints.Header />
          <breakpoints.Body />
        </StoreProvider>
      );
  const dispose = render(ui, container);
  return {
    store,
    loop,
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("Breakpoints section — header", () => {
  it("renders Run/Pause only (Cold boot now lives in the App-shell section)", async () => {
    harness = await mount();
    const btns = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>(
        ".bp-controls button",
      ),
    ).map((b) => b.textContent);
    // Run/Pause label flips with status; while paused (default) it reads "Run".
    expect(btns).toEqual([STR.breakpoints.run]);
  });

  it("effective-clock indicator reads '—' and greys before any run", async () => {
    harness = await mount();
    const clock = req(
      harness.container.querySelector<HTMLElement>(".bp-clock"),
      "clock",
    );
    expect(clock.textContent).toBe(STR.breakpoints.clockIdle);
    expect(clock.classList.contains("bp-clock-idle")).toBe(true);
    // Entering 'running' drops the greyed treatment (the value itself stays
    // '—' until a tick lands a measurement).
    harness.store.run();
    await flush();
    expect(clock.classList.contains("bp-clock-idle")).toBe(false);
  });

  it("Run/Pause toggle stays enabled regardless of state", async () => {
    harness = await mount();
    harness.loop.setStatus("running");
    harness.store.pause();
    harness.store.run();
    await flush();
    const pauseBtn = buttonByText(harness.container, STR.breakpoints.pause);
    expect(pauseBtn.disabled).toBe(false);
  });

  it("status line reflects pc-breakpoint reason", async () => {
    harness = await mount();
    harness.loop.emitPause({
      kind: "pc-breakpoint",
      pc: 0x8042,
      lo: 0x8000,
      hi: 0x80ff,
    });
    await flush();
    const status = req(harness.container.querySelector(".bp-status"), "status");
    expect(status.textContent).toContain("BP PC=8042");
  });

  it("status line reflects hc-target reason", async () => {
    harness = await mount();
    harness.loop.emitPause({ kind: "hc-target", target: 12345 });
    await flush();
    const status = req(harness.container.querySelector(".bp-status"), "status");
    expect(status.textContent).toContain("HC target 12,345");
  });
});

describe("Breakpoints section — body", () => {
  it("starts with only the add stub when no BPs are set", async () => {
    harness = await mount();
    const rows = harness.container.querySelectorAll(".bp-row");
    expect(rows.length).toBe(1);
    expect(rows[0].classList.contains("bp-add-stub")).toBe(true);
  });

  it("add stub creates a PC-range BP and clears its inputs", async () => {
    harness = await mount();
    const loInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-add-stub input[aria-label="${STR.breakpoints.bpPcLoLabel}"]`,
      ),
      "add-stub lo input",
    );
    const hiInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-add-stub input[aria-label="${STR.breakpoints.bpPcHiLabel}"]`,
      ),
      "add-stub hi input",
    );
    fireEvent.input(loInput, { target: { value: "8000" } });
    fireEvent.input(hiInput, { target: { value: "80FF" } });
    buttonByText(harness.container, STR.breakpoints.addBp).click();
    expect(harness.store.breakpoints.length).toBe(1);
    expect(harness.store.breakpoints[0]).toMatchObject({
      kind: "pc-range",
      lo: 0x8000,
      hi: 0x80ff,
      enabled: true,
    });
    // Inputs cleared so the next add starts fresh.
    expect(loInput.value).toBe("");
    expect(hiInput.value).toBe("");
  });

  it("add stub defaults hi to lo when hi is empty (single-address BP)", async () => {
    harness = await mount();
    const loInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-add-stub input[aria-label="${STR.breakpoints.bpPcLoLabel}"]`,
      ),
      "add-stub lo input",
    );
    fireEvent.input(loInput, { target: { value: "4000" } });
    buttonByText(harness.container, STR.breakpoints.addBp).click();
    expect(harness.store.breakpoints[0]).toMatchObject({
      lo: 0x4000,
      hi: 0x4000,
    });
  });

  it("add stub creates an HC-count BP after switching kind", async () => {
    harness = await mount();
    const select = req(
      harness.container.querySelector<HTMLSelectElement>(".bp-add-stub select"),
      "kind select",
    );
    fireEvent.change(select, { target: { value: "hc-count" } });
    const target = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-add-stub input[aria-label="${STR.breakpoints.bpHcTargetLabel}"]`,
      ),
      "add-stub target input",
    );
    fireEvent.input(target, { target: { value: "12345" } });
    buttonByText(harness.container, STR.breakpoints.addBp).click();
    expect(harness.store.breakpoints[0]).toMatchObject({
      kind: "hc-count",
      target: 12345,
    });
  });

  it("invalid PC range marks inputs invalid without adding a BP", async () => {
    harness = await mount();
    const loInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-add-stub input[aria-label="${STR.breakpoints.bpPcLoLabel}"]`,
      ),
      "add-stub lo input",
    );
    const hiInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-add-stub input[aria-label="${STR.breakpoints.bpPcHiLabel}"]`,
      ),
      "add-stub hi input",
    );
    fireEvent.input(loInput, { target: { value: "8000" } });
    fireEvent.input(hiInput, { target: { value: "1000" } });
    buttonByText(harness.container, STR.breakpoints.addBp).click();
    expect(harness.store.breakpoints.length).toBe(0);
    expect(loInput.classList.contains("is-invalid")).toBe(true);
  });

  it("toggle checkbox flips enabled", async () => {
    harness = await mount();
    harness.store.addBreakpoint({ kind: "hc-count", target: 100 });
    await flush();
    const checkbox = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-row:not(.bp-add-stub) input[type="checkbox"]`,
      ),
      "row checkbox",
    );
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(harness.store.breakpoints[0].enabled).toBe(false);
  });

  it("delete button removes the row", async () => {
    harness = await mount();
    harness.store.addBreakpoint({ kind: "hc-count", target: 100 });
    await flush();
    const delBtn = req(
      harness.container.querySelector<HTMLButtonElement>(
        ".bp-row:not(.bp-add-stub) .bp-delete",
      ),
      "delete button",
    );
    delBtn.click();
    expect(harness.store.breakpoints.length).toBe(0);
  });

  it("edit hi commits on blur with a valid new value", async () => {
    harness = await mount();
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0x100, hi: 0x100 });
    await flush();
    const hiInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-row:not(.bp-add-stub) input[aria-label="${STR.breakpoints.bpPcHiLabel}"]`,
      ),
      "hi input",
    );
    fireEvent.input(hiInput, { target: { value: "1FF" } });
    fireEvent.blur(hiInput);
    expect(harness.store.breakpoints[0]).toMatchObject({
      lo: 0x100,
      hi: 0x1ff,
    });
  });

  it("edit lo > hi clamps hi up to the new lo value", async () => {
    harness = await mount();
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0x100, hi: 0x200 });
    await flush();
    const loInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-row:not(.bp-add-stub) input[aria-label="${STR.breakpoints.bpPcLoLabel}"]`,
      ),
      "lo input",
    );
    fireEvent.input(loInput, { target: { value: "300" } });
    fireEvent.blur(loInput);
    // Both lo and hi collapse to the new value.
    expect(harness.store.breakpoints[0]).toMatchObject({
      lo: 0x300,
      hi: 0x300,
    });
    expect(loInput.classList.contains("is-invalid")).toBe(false);
  });

  it("HC target row edits and commits", async () => {
    harness = await mount();
    harness.store.addBreakpoint({ kind: "hc-count", target: 100 });
    await flush();
    const tInput = req(
      harness.container.querySelector<HTMLInputElement>(
        `.bp-row:not(.bp-add-stub) input[aria-label="${STR.breakpoints.bpHcTargetLabel}"]`,
      ),
      "target input",
    );
    fireEvent.input(tInput, { target: { value: "99999" } });
    fireEvent.blur(tInput);
    expect(harness.store.breakpoints[0]).toMatchObject({ target: 99999 });
  });
});

describe("Breakpoints section — folded summary", () => {
  it("shows the empty hint with no BPs", async () => {
    harness = await mount({ folded: true });
    expect(harness.container.textContent).toContain(
      STR.breakpoints.foldedEmpty,
    );
  });

  it("shows total + enabled count when BPs exist", async () => {
    harness = await mount({ folded: true });
    harness.store.addBreakpoint({ kind: "pc-range", lo: 0, hi: 0 });
    harness.store.addBreakpoint({
      kind: "hc-count",
      target: 100,
      enabled: false,
    });
    await flush();
    // "2 BPs · 1 enabled"
    expect(harness.container.textContent).toContain("2 BPs");
    expect(harness.container.textContent).toContain("1 enabled");
  });
});
