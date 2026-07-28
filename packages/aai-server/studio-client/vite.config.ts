// Copyright 2025 the AAI authors. MIT license.
// Builds the studio's React client into dist/studio-client, served by the
// platform server at `/` (shell) and `/studio-assets/` (hashed assets).

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "/studio-assets/",
  plugins: [tailwindcss()],
  build: {
    outDir: "../dist/studio-client",
    emptyOutDir: true,
  },
});
