// Browser-mode test for the breakpoint pipeline: real rAF + real DOM,
// to prove the per-edge BP check fires under the production scheduler
// and that the rendered status line picks up the new reason.
//
// Unit-tier tests already cover the evaluator logic and store wiring
// against `_tickFrameSync()`; this layer adds the integration that
// can't be faked — real `requestAnimationFrame`, real signal flush,
// real DOM update path.

import { page } from "@vitest/browser/context";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BootedApp, bootApp } from "../../boot.tsx";
import { MemoryBackend } from "../../storage/memory.ts";
import "../../styles.css";

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
  };
}

// Fresh MemoryBackend per test — the default backend is IndexedDB, which
// persists across tests in the same browser context. `addBreakpoint`
// below writes to the backend, so without isolation the next test would
// inherit the previous run's BPs.
beforeEach(async () => {
  await mountApp(new MemoryBackend());
});

afterEach(() => {
  dispose();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Breakpoints (browser smoke)", () => {
  it("HC-count BP fires under real rAF and the status line shows the reason", async () => {
    // Pick a target small enough to hit within a couple of rAF frames
    // at full speed (~40M HC/sec budget gives us ~400k edges per
    // frame — 1000 lands in the first frame).
    booted.store.addBreakpoint({ kind: "hc-count", target: 1000 });

    const runBtn = page.getByRole("button", { name: "Run" });
    await runBtn.click();

    // Poll for the pause — the loop runs on rAF; allow a few frames.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && booted.store.status() !== "paused") {
      await sleep(16);
    }

    expect(booted.store.status()).toBe("paused");
    expect(booted.store.hc()).toBeGreaterThanOrEqual(1000);
    expect(booted.store.lastPauseReason()).toEqual({
      kind: "hc-target",
      target: 1000,
    });

    // Status line in the rendered DOM picked up the reason. Reaching
    // through the store proves the state changed; reaching through the
    // page proves the reactive subscription survived the rAF + signal
    // batching that the unit tier never exercises.
    await expect.element(page.getByText(/HC target 1,000/)).toBeInTheDocument();
  });
});
