// Builds the default client SPA via stock Vite.
// Output: dist/default-client/ (HTML + JS assets) — served by the server.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_FAVICON } from "@alexkroman1/aai";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Inject the shared favicon into the shell's `<head>`.
 *
 * A build-time injection rather than a literal in `index.html` so the icon has
 * exactly ONE definition (`AGENT_FAVICON`), shared with the CLI's `DEFAULT_HTML`
 * — the two shells previously linked `favicon.ico` with different paths
 * (`/favicon.ico` here, `./favicon.ico` there) and neither resolved to anything,
 * so every agent page 404'd on load.
 */
function faviconPlugin(): Plugin {
  return {
    name: "aai-favicon",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replace("</head>", `  <link rel="icon" href="${AGENT_FAVICON}" />\n  </head>`),
    },
  };
}

await build({
  root: __dirname,
  base: "./",
  logLevel: "warn",
  configFile: false,
  resolve: { conditions: ["@dev/source"] },
  plugins: [react(), tailwindcss(), faviconPlugin()],
  build: {
    outDir: path.join(__dirname, "dist", "default-client"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(__dirname, "index.html"),
    },
  },
});

console.log("Built dist/default-client/");
