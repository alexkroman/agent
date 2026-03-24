import { defineConfig } from "tsdown";

export default defineConfig([
  // Main server bundle
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1/],
    external: ["isolated-vm"],
  },
  // Harness runtime — CJS bundle for V8 isolates
  {
    entry: ["src/_harness_runtime.ts"],
    format: "cjs",
    platform: "node",
    target: "node22",
    outDir: "dist",
    external: ["./agent_bundle.js"],
  },
]);
