import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["cli.ts", "testing.ts", "matchers.ts", "types.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
