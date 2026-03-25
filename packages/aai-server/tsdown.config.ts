import { defineConfig } from "tsdown";

export default defineConfig([
  // Main server bundle — bundle workspace packages, externalize npm deps
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1/],
  },
  // Harness runtime — loaded into secure-exec isolates.
  // Uses node:http directly (not Hono) because @hono/node-server redefines
  // globalThis.Request which conflicts with secure-exec's frozen built-ins.
  {
    entry: ["src/_harness-runtime.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
  },
]);
