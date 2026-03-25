import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
