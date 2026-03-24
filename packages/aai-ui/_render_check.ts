// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import preact from "@preact/preset-vite";
import { type Alias, createServer as createViteServer, type Plugin } from "vite";

/**
 * Smoke-test a client.tsx by loading it via Vite SSR in a DOM-shimmed
 * environment. The module's top-level `mount()` call executes as a side
 * effect; if it throws, the client code has a render-time bug.
 *
 * Imports linkedom dynamically so this module can be loaded even when
 * linkedom is not installed (the caller catches and skips).
 */
export async function renderCheck(clientEntry: string, cwd: string): Promise<void> {
  // Dynamic imports so esbuild doesn't bundle linkedom into the CLI dist.
  const { DOMParser, installDomShim } = await import("./_dom_shim.ts");
  const { installMockWebSocket } = await import("@alexkroman1/aai/testing");

  installDomShim();

  const g = globalThis as unknown as Record<string, unknown>;
  const doc = new DOMParser().parseFromString(
    '<!DOCTYPE html><html><head></head><body><main id="app"></main></body></html>',
    "text/html",
  );
  const prevDoc = g.document;
  const prevLocation = g.location;
  g.document = doc;
  g.location = { origin: "http://localhost:3000", pathname: "/", href: "http://localhost:3000/" };

  // Build resolve.alias from package.json exports so templates can
  // reference workspace packages and resolve to local .ts source.
  // Vite's SSR loader doesn't support self-referencing exports (vitejs#9731),
  // so resolve.alias is the standard workaround for monorepo-style setups.
  const uiRoot = import.meta.dirname ?? __dirname;
  const packagesRoot = path.resolve(uiRoot, "..");
  const fs = await import("node:fs/promises");
  const alias: Alias[] = [];

  // Load exports from each workspace package
  for (const pkgDir of ["aai", "aai-ui"]) {
    const pkgPath = path.join(packagesRoot, pkgDir, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
    for (const [key, val] of Object.entries(pkg.exports ?? {})) {
      const source =
        typeof val === "string"
          ? val
          : typeof val === "object" && val !== null && "source" in val
            ? (val as Record<string, string>).source
            : null;
      if (typeof source === "string" && source.endsWith(".ts")) {
        alias.push({
          find: `${pkg.name}${key === "." ? "" : key.slice(1)}`,
          replacement: path.resolve(packagesRoot, pkgDir, source),
        });
      }
    }
  }

  // Sort longest-first so `@pkg/name/session` matches before `@pkg/name`.
  alias.sort((a, b) => (b.find as string).length - (a.find as string).length);
  const cssNoop: Plugin = {
    name: "ssr-css-noop",
    enforce: "pre",
    resolveId: (id) => (id.endsWith(".css") ? "\0css-noop" : undefined),
    load: (id) => (id === "\0css-noop" ? "" : undefined),
  };

  const mock = installMockWebSocket();
  const vite = await createViteServer({
    root: cwd,
    logLevel: "silent",
    plugins: [preact(), cssNoop],
    resolve: { alias, dedupe: ["preact", "@preact/signals"] },
    ssr: { noExternal: ["@alexkroman1/aai", "@alexkroman1/aai-ui"] },
    server: { middlewareMode: true },
  });

  try {
    await vite.ssrLoadModule(clientEntry);
    const app = (doc as unknown as Document).querySelector("#app");
    if (!app?.innerHTML) {
      throw new Error("client.tsx render check failed: #app is empty after mount()");
    }
  } finally {
    await vite.close();
    mock.restore();
    g.document = prevDoc;
    g.location = prevLocation;
  }
}
