/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import pkg from "./package.json" with { type: "json" };

// Short git SHA at build time. Falls back to "dev" if git isn't
// available (e.g. unpacked tarball) so the global is always a string.
function getBuildSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

// Two test projects: fast happy-dom unit tests for most logic, plus a
// browser project (Playwright/Chromium) for the few cases happy-dom
// can't fairly simulate — HTML5 drag-and-drop, real focus + global
// keydown interactions, etc. Browser tests are named `*.browser.test.tsx`
// so the unit project's glob can cleanly exclude them.
//
// `base` is conditional on command so only `vite build` emits asset
// paths under `/z80cpu-lab/` — the GitHub Pages subpath this monorepo
// deploys to. Dev (`vite dev`) and preview (`vite preview`) both stay
// at `/` for local convenience.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/z80cpu-lab/" : "/",
  plugins: [solid()],
  server: {
    open: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(getBuildSha()),
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
}));
