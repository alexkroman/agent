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
    entry: ["guest/deno-harness.ts"],
    format: "esm",
    target: "node22",
    outDir: "dist/guest",
    noExternal: [/.*/], // Bundle everything -- guest has no node_modules
  },
  {
    entry: { _zod: "zod-shim.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
  },
]);
