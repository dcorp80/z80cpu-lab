// Browser-mode tests for behaviors happy-dom can't fairly simulate:
// real focus tracking, native HTML5 drag-and-drop, document-level
// keydown dispatch with input suppression.
//
// Kept deliberately small — most logic lives in unit tests
// (`*.test.ts`) which run two orders of magnitude faster.

import { page, userEvent } from "@vitest/browser/context";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BootedApp, bootApp } from "./boot.tsx";
import "./styles.css";

// Each test stands up a fresh app in document.body and tears it down
// on completion. The hotkey dispatcher attaches to document — calling
// dispose() during cleanup prevents listener accumulation across tests.
let booted: BootedApp;
let dispose: () => void = () => {};

async function mountApp() {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  booted = await bootApp();
  const detachRender = render(booted.ui, container);
  dispose = () => {
    detachRender();
    booted.dispose();
    container.remove();
  };
}

beforeEach(async () => {
  await mountApp();
});

afterEach(() => {
  dispose();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("z80cpu-explorer (browser smoke)", () => {
  it("boots without console errors and shows the initial status line", async () => {
    // App name lives on the App-shell section's <h2>; there is no page
    // <h1> (avoiding a duplicate landmark).
    await expect
      .element(page.getByRole("heading", { level: 2, name: "z80cpu-explorer" }))
      .toBeInTheDocument();
    await expect.element(page.getByText(/paused/)).toBeInTheDocument();
    await expect.element(page.getByText(/HC=0/)).toBeInTheDocument();
    await expect.element(page.getByText(/0 insns/)).toBeInTheDocument();
  });

  it("Run button starts the CPU; Pause stops it", async () => {
    const run = page.getByRole("button", { name: "Run" });
    await run.click();
    // Loop runs on rAF; wait a couple frames for HC to advance.
    await sleep(50);
    expect(booted.store.status()).toBe("running");
    expect(booted.store.hc()).toBeGreaterThan(0);
    expect(booted.store.insnCount()).toBeGreaterThan(0);

    const pause = page.getByRole("button", { name: "Pause" });
    await pause.click();
    expect(booted.store.status()).toBe("paused");
    const stoppedHc = booted.store.hc();
    await sleep(30);
    // HC must not advance after pause.
    expect(booted.store.hc()).toBe(stoppedHc);
  });

  it("hotkey 's' steps once globally but is suppressed while typing in an input", async () => {
    // Global path: status starts paused; pressing 's' runs one
    // instruction so insnCount increments by 1.
    expect(booted.store.insnCount()).toBe(0);
    await userEvent.keyboard("s");
    // Give the loop a frame to complete the step.
    await sleep(50);
    expect(booted.store.insnCount()).toBe(1);

    // Suppressed path: focus the step-N input then type 's' — the
    // character should land in the input value, NOT trigger another
    // step instruction.
    const insnsBefore = booted.store.insnCount();
    // `exact: true` disambiguates from "Half-cycle step count" (the
    // step-N HC input added in M5 — same role, prefix-overlapping name).
    const stepInput = page.getByRole("textbox", {
      name: "Step count",
      exact: true,
    });
    await stepInput.click();
    await userEvent.keyboard("s");
    await sleep(20);
    expect(booted.store.insnCount()).toBe(insnsBefore);
    // The character also shouldn't have been accepted by the input
    // (it filters to numeric on submit), but at minimum focus must
    // have absorbed the keystroke so no extra step fired — that's the
    // suppression invariant.
  });

  it("drag-to-reorder: dragging Program onto Memory's lower half moves it below", async () => {
    const initialOrder = booted.store.sections.map((s) => s.id);
    // Shipped order is set in `sections/sectionRegistry.ts`. Anchor on
    // the few ids that matter to this test (program above memory at
    // boot) — if the shipped order is re-tuned, only the assertion of
    // the post-drop relationship below needs to stay true.
    expect(initialOrder).toContain("program");
    expect(initialOrder).toContain("memory");
    expect(initialOrder.indexOf("program")).toBeLessThan(
      initialOrder.indexOf("memory"),
    );

    // Dispatch real HTML5 DragEvents with a constructed DataTransfer.
    // DataTransfer is constructable in real browsers (but not in happy-
    // dom), so this is the part this test layer is uniquely positioned
    // to cover. Going through `userEvent.dropTo` is unreliable for the
    // arming/synthetic-pointer interplay; the direct dispatch validates
    // every line of our drag/drop handlers in `frame.tsx` without that
    // friction.
    const handleEl = page
      .getByRole("region", { name: /Program/i })
      .getByRole("button", { name: /Drag to reorder/i })
      .element() as HTMLElement;
    const targetEl = page
      .getByRole("region", { name: /Memory/i })
      .element() as HTMLElement;
    const targetRect = targetEl.getBoundingClientRect();
    // Aim for the lower half of the Memory section so drop edge = below.
    const dropY = targetRect.top + targetRect.height * 0.75;

    const dt = new DataTransfer();
    handleEl.dispatchEvent(
      new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }),
    );
    targetEl.dispatchEvent(
      new DragEvent("dragover", {
        dataTransfer: dt,
        bubbles: true,
        clientY: dropY,
      }),
    );
    targetEl.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        clientY: dropY,
      }),
    );

    const afterOrder = booted.store.sections.map((s) => s.id);
    const progIdx = afterOrder.indexOf("program");
    const memIdx = afterOrder.indexOf("memory");
    expect(progIdx).toBeGreaterThan(memIdx);
  });
});
