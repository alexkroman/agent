import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1/],
  },
  {
    entry: ["harness-runtime.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1\/aai\/hooks/, /@alexkroman1\/aai\/utils/, /^hookable$/],
  },
  {
    entry: { _zod: "zod-shim.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
  },
]);
