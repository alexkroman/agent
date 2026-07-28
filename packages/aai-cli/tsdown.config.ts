import { defineConfig } from "tsdown";

export default defineConfig({
  // The *-bundler modules are public subpath exports (aai-server's studio
  // builds workspaces through them); types.ts backs the "./types" export.
  entry: ["cli.ts", "types.ts", "client-bundler.ts", "worker-bundler.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
