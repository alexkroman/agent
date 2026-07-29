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
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
