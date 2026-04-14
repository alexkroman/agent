// Builds the default client SPA via stock Vite.
// Output: dist/default-client/ (HTML + JS assets) — served by the server.

import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  root: __dirname,
  base: "./",
  logLevel: "warn",
  configFile: false,
  resolve: { conditions: ["@dev/source"] },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(__dirname, "dist", "default-client"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(__dirname, "index.html"),
    },
  },
});

console.log("Built dist/default-client/");
