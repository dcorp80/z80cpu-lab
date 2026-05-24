import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/repl.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  minify: true,
  target: "es2022",
  splitting: false,
  treeshake: true,
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@dcorp80/z80cpu",
    "@dcorp80/z80cpu-debug",
    "@dcorp80/z80cpu-disasm",
  ],
});
