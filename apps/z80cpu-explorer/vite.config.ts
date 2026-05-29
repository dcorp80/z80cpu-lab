/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Two test projects: fast happy-dom unit tests for most logic, plus a
// browser project (Playwright/Chromium) for the few cases happy-dom
// can't fairly simulate — HTML5 drag-and-drop, real focus + global
// keydown interactions, etc. Browser tests are named `*.browser.test.tsx`
// so the unit project's glob can cleanly exclude them.
export default defineConfig({
  plugins: [solid()],
  server: {
    open: true,
  },
  test: {
    // The root config's `environment` is what Vitest probes for an
    // implicit dependency on (jsdom by default). Force "node" so it
    // doesn't ask us to install jsdom — the actual environments live
    // in the projects below.
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "happy-dom",
          globals: false,
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.browser.test.ts", "src/**/*.browser.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts", "src/**/*.browser.test.tsx"],
          browser: {
            enabled: true,
            provider: "playwright",
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
