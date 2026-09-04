import { defineConfig } from "tsdown";

export default defineConfig({
  // The *-bundler and typecheck modules are public subpath exports (the
  // guest sandbox builds and typechecks workspaces through them).
  entry: [
    "src/cli.ts",
    "src/client-bundler.ts",
    "src/worker-bundler.ts",
    "src/typecheck.ts",
    "src/project-config.ts",
  ],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  // Declarations come from `tsc -p tsconfig.build.json`, as in aai/aai-ui.
  // tsdown turns dts on by itself once the exports map declares `types`, and
  // its pass emits a .d.ts next to EVERY file in the program — which, because
  // `@dev/source` resolves cross-package imports to TypeScript source, means
  // stray declarations landing in aai-server and at the repo root.
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  deps: { neverBundle: [/^[^./]/] },
});
