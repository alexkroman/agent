import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["harness.ts"],
  platform: "node",
  format: "esm",
  target: "node22",
  outDir: "dist",
  // Bundle everything the harness itself runs -- EXCEPT the build toolchain,
  // which stays a runtime import resolved from the node_modules baked next
  // to the harness (modal-harness-image.ts installs it; in dev the harness
  // sits inside this package, whose own node_modules provide it). Bundling
  // Vite/Rollup into the harness would be both enormous and broken (native
  // rolldown binaries).
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: [
      /^@alexkroman1\/aai-cli(\/|$)/,
      /^@vitejs\/plugin-react(\/|$)/,
      /^@tailwindcss\/vite(\/|$)/,
    ],
  },
  // ONE artifact: the harness is baked into the guest image as a single
  // file (aai-server's modal-harness-image.ts), so the providers' lazy
  // imports must be inlined rather than emitted as sibling chunks the
  // guest can't load. (External dynamic imports -- the toolchain above --
  // stay external.)
  outputOptions: { codeSplitting: false },
});
