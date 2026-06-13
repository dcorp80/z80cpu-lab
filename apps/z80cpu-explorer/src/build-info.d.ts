// Build-time globals injected by Vite's `define` (see vite.config.ts).
// `__APP_VERSION__` comes from apps/z80cpu-explorer/package.json;
// `__BUILD_SHA__` is `git rev-parse --short HEAD` or "dev" when git
// is unavailable. Both are baked in as string literals at build time.
declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;
