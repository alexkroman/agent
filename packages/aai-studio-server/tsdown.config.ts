import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // Service entry: AAI_SERVICE=studio (standalone) or combined (default).
    // One bundle per process — `aai` and `aai-server` are compiled in, so
    // module-level state (slot caches, keyed locks, session notes) has
    // exactly one copy in the running process.
    entry: ["index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    deps: { alwaysBundle: [/^aai$/, /^aai-server$/] },
  },
  {
    // Build-worker CLI: run by the `studio_build` Modal Function.
    entry: ["studio-build-entry.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    deps: { alwaysBundle: [/^aai$/, /^aai-server$/] },
  },
]);
