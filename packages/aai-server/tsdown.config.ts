import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1/],
  },
  {
    entry: ["src/lib/harness-runtime.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1\/aai\/hooks/, /@alexkroman1\/aai\/utils/, /^hookable$/],
  },
  {
    entry: { _zod: "src/lib/zod-shim.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
  },
]);
