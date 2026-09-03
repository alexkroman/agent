// Builds the default client SPA via stock Vite.
// Output: dist/default-client/ (HTML + JS assets) — served by the server.

import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";

// The PACKAGE root, not this file's own directory: `index.html`, `public/`
// and `dist/` all sit beside `src/`, which is the layout Vite expects of a
// project root (and the one `aai-studio-client` already has).
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  root: packageDir,
  base: "./",
  logLevel: "warn",
  configFile: false,
  resolve: { conditions: ["@dev/source"] },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(packageDir, "dist", "default-client"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(packageDir, "index.html"),
    },
  },
});

console.log("Built dist/default-client/");
