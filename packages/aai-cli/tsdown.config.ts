import { defineConfig } from "tsdown";

export default defineConfig({
  // The *-bundler and typecheck modules are public subpath exports (the
  // guest sandbox builds and typechecks workspaces through them).
  entry: ["cli.ts", "client-bundler.ts", "worker-bundler.ts", "typecheck.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
