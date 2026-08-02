// Copyright 2025 the AAI authors. MIT license.
// Builds the studio's React client into dist/, served by the platform server
// (aai-server) at `/` (shell) and `/studio-assets/` (hashed assets) — the
// server resolves this package's dist the way it resolves aai-ui's
// default-client (see aai-server/studio/studio-static.ts).

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "/studio-assets/",
  // Errors only: the default `info` level prints the full per-asset listing
  // plus the >500 kB chunk-size warning on every build. The two big chunks
  // (CodeMirror's code-view split and the main bundle) are ~180 kB gzipped —
  // acceptable for a load-once internal SPA, so the warning is pure noise.
  logLevel: "error",
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
