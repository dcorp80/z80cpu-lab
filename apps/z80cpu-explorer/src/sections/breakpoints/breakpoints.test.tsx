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
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop, type StubLoop } from "../../store/testStubLoop.ts";
import { STR } from "../../style/strings.ts";
import { breakpoints } from "./index.tsx";

function makeStubBus() {
  let v = 0xff;
  return {
    mem: new Uint8Array(0x10000).fill(0xff),
    intVector: () => v,
    setIntVector: (b: number) => {
      v = b & 0xff;
    },
  };
}

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

function req<T>(x: T | null | undefined, name: string): T {
  if (x == null) throw new Error(`expected element: ${name}`);
  return x;
}

// Flush pending microtasks so persistence + signal propagation settle.
const flush = () => new Promise<void>((r) => queueMicrotask(r));

const buttonByText = (root: HTMLElement, text: string): HTMLButtonElement =>
  req(
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === text,
    ),
    `button "${text}"`,
  );

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("Breakpoints section — header", () => {
  it("renders all five step/control buttons + Reinit", async () => {
    harness = await mount();
    const btns = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>(
        ".bp-controls button",
      ),
    ).map((b) => b.textContent);
    // Run/Pause label flips with status; while paused (default) it reads
    // "Run". The full set of operations is present in one row.
    expect(btns).toEqual(
      expect.arrayContaining([
        STR.breakpoints.run,
        STR.breakpoints.step,
        STR.breakpoints.stepN,
        STR.breakpoints.stepHc,
        STR.breakpoints.stepNHc,
        STR.breakpoints.zeroHc,
        STR.breakpoints.reinit,
      ]),
    );
  });

  it("step buttons disabled while running, Run/Pause stays clickable", async () => {
    harness = await mount();
    // Force the stub into running state, then re-read button state.
    harness.loop.setStatus("running");
    // Click anything reactive so the store's status accessor sees the
    // change — the stub doesn't fire its own status events, but the
    // store reads loop.status() inside accessors that re-evaluate on
    // signal updates. Simpler: trigger a run() through the store so the
    // store's own internal setStatus fires.
    harness.store.pause(); // resets to paused so accessors re-sample
    harness.store.run();
    await flush();
    const stepBtn = buttonByText(harness.container, STR.breakpoints.step);
    const stepHcBtn = buttonByText(harness.container, STR.breakpoints.stepHc);
    const zeroBtn = buttonByText(harness.container, STR.breakpoints.zeroHc);
    const reinitBtn = buttonByText(harness.container, STR.breakpoints.reinit);
    expect(stepBtn.disabled).toBe(true);
    expect(stepHcBtn.disabled).toBe(true);
    expect(zeroBtn.disabled).toBe(true);
    expect(reinitBtn.disabled).toBe(true);
    // Pause/Run toggle stays enabled regardless of state.
    const pauseBtn = buttonByText(harness.container, STR.breakpoints.pause);
    expect(pauseBtn.disabled).toBe(false);
  });

  it("Step HC forwards stepHC(1) to the loop", async () => {
    harness = await mount();
    buttonByText(harness.container, STR.breakpoints.stepHc).click();
    expect(harness.loop.lastCmd).toBe("stepHC");
    expect(harness.loop.lastStepN).toBe(1);
  });

  it("Step N HC reads the HC-count input and forwards", async () => {
    harness = await mount();
    const input = req(
      harness.container.querySelector<HTMLInputElement>(
        `input[aria-label="${STR.breakpoints.stepHcCountLabel}"]`,
      ),
      "step-hc-N input",
    );
    fireEvent.input(input, { target: { value: "42" } });
    buttonByText(harness.container, STR.breakpoints.stepNHc).click();
    expect(harness.loop.lastCmd).toBe("stepHC");
    expect(harness.loop.lastStepN).toBe(42);
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

  it("edit lo > hi is rejected and marks the field invalid", async () => {
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
    // Edit rejected — BP unchanged, input marked invalid.
    expect(harness.store.breakpoints[0]).toMatchObject({
      lo: 0x100,
      hi: 0x200,
    });
    expect(loInput.classList.contains("is-invalid")).toBe(true);
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
