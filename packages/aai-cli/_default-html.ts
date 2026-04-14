// Copyright 2025 the AAI authors. MIT license.

/**
 * Default index.html for agents with a custom client.tsx but no index.html.
 * Used by both the dev server (Vite HMR) and the production bundler.
 * Users can override by placing their own index.html in the project root.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const DEFAULT_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>aai</title>
    <link rel="icon" href="data:," />
    <style>html, body { background: #101010; margin: 0; }</style>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="./client.tsx"></script>
  </body>
</html>`;

/**
 * Vite plugin that serves a fallback index.html when one doesn't exist on disk.
 * Allows user override — if index.html exists in the project, this plugin is a no-op.
 */
export function fallbackHtmlPlugin(root: string): Plugin {
  const htmlExists = existsSync(path.join(root, "index.html"));
  return {
    name: "aai-fallback-html",
    configureServer(server) {
      if (htmlExists) return;
      // Pre-middleware: intercept before Vite's built-in HTML handling
      server.middlewares.use((req, res, next) => {
        if (req.url === "/" || req.url === "/index.html") {
          server.transformIndexHtml("/", DEFAULT_HTML, req.originalUrl).then((html) => {
            res.setHeader("Content-Type", "text/html");
            res.end(html);
          }, next);
          return;
        }
        next();
      });
    },
    resolveId(id) {
      if (!htmlExists && id.endsWith("/index.html")) return "\0fallback-index.html";
    },
    load(id) {
      if (id === "\0fallback-index.html") return DEFAULT_HTML;
    },
  };
}
