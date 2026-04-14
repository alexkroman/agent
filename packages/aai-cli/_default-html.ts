// Copyright 2025 the AAI authors. MIT license.

/**
 * Default index.html for agents with a custom client.tsx but no index.html.
 * Used by both the dev server (Vite HMR) and the production bundler.
 * Users can override by placing their own index.html in the project root.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export const DEFAULT_HTML = `<!DOCTYPE html>
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
 * Vite plugin that serves a fallback index.html in dev mode when one doesn't
 * exist on disk. No-op if index.html exists (user override).
 */
export function fallbackHtmlPlugin(root: string): Plugin {
  const htmlExists = existsSync(path.join(root, "index.html"));
  return {
    name: "aai-fallback-html",
    configureServer(server) {
      if (htmlExists) return;
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
  };
}

/**
 * Write a temporary index.html for Vite build (HTML must be on disk for build).
 * Returns a cleanup function to remove it. No-op if index.html already exists.
 */
export function writeTempHtml(root: string): () => void {
  const htmlPath = path.join(root, "index.html");
  if (existsSync(htmlPath))
    return () => {
      /* no-op: user-provided */
    };
  writeFileSync(htmlPath, DEFAULT_HTML);
  return () => {
    try {
      unlinkSync(htmlPath);
    } catch {
      /* best-effort cleanup */
    }
  };
}
