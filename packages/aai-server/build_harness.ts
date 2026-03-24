// Builds _harness_runtime.ts as a CJS bundle for V8 isolate execution.
// Uses Vite (same as the CLI bundler) instead of raw esbuild.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));

await build({
  configFile: false,
  root: dir,
  logLevel: "warn",
  build: {
    lib: {
      entry: path.join(dir, "src/_harness_runtime.ts"),
      formats: ["cjs"],
      fileName: () => "_harness_runtime.js",
    },
    rollupOptions: {
      external: ["./agent_bundle.js"],
    },
    outDir: path.join(dir, "dist"),
    emptyOutDir: false,
    minify: true,
    target: "es2022",
  },
});
