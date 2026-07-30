import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    deps: { alwaysBundle: [/^aai$/] },
  },
  {
    // Build-worker CLI: run by the `studio_build` Modal Function
    // (modal_deploy.py) to execute studio builds out of process.
    entry: ["studio/studio-build-entry.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist/studio",
    deps: { alwaysBundle: [/^aai$/] },
  },
  {
    entry: ["guest/deno-harness.ts"],
    format: "esm",
    target: "node22",
    outDir: "dist/guest",
    // Bundle everything -- guest has no node_modules
    deps: { alwaysBundle: [/.*/] },
  },
]);
