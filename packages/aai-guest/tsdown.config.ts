import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["harness.ts"],
  platform: "node",
  format: "esm",
  target: "node22",
  outDir: "dist",
  // Bundle everything -- the guest sandbox has no node_modules.
  deps: { alwaysBundle: [/.*/] },
  // ONE artifact: the harness is baked into the guest image as a single
  // file (aai-server's modal-harness-image.ts), so the providers' lazy
  // imports must be inlined rather than emitted as sibling chunks the
  // guest can't load.
  outputOptions: { inlineDynamicImports: true },
});
