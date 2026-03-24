import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  external: [/^[^./]/],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
