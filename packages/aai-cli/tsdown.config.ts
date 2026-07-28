import { defineConfig } from "tsdown";

export default defineConfig({
  // client-bundler.ts is a public subpath export (aai-server's studio
  // reuses it); types.ts backs the "./types" export.
  entry: ["cli.ts", "types.ts", "client-bundler.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
