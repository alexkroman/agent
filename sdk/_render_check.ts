// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import preact from "@preact/preset-vite";
import { createServer as createViteServer, type Plugin } from "vite";

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
  const { DOMParser, installDomShim } = await import("../ui/_dom_shim.ts");
  const { installMockWebSocket } = await import("./_mock_ws.ts");

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

  // Build a map from package exports so templates can import
  // `@<scope>/aai/ui` etc. and resolve to the local source files.
  const pkgRoot = path.resolve(import.meta.dirname ?? __dirname, "..");
  const pkg = JSON.parse(
    await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(pkgRoot, "package.json"), "utf-8"),
    ),
  );
  const exportMap = new Map<string, string>();
  for (const [key, val] of Object.entries(pkg.exports ?? {}) as [string, { source?: string }][]) {
    if (val?.source) {
      exportMap.set(`${pkg.name}${key.slice(1)}`, path.resolve(pkgRoot, val.source));
    }
  }
  // Also handle plain string exports like "./ui/styles.css"
  for (const [key, val] of Object.entries(pkg.exports ?? {})) {
    if (typeof val === "string") {
      exportMap.set(`${pkg.name}${key.slice(1)}`, path.resolve(pkgRoot, val));
    }
  }

  const pkgResolverPlugin: Plugin = {
    name: "resolve-local-pkg",
    enforce: "pre",
    resolveId(id) {
      if (id.endsWith(".css")) return "\0css-noop";
      const resolved = exportMap.get(id);
      if (resolved) return resolved;
    },
    load(id) {
      if (id === "\0css-noop") return "";
    },
  };

  const mock = installMockWebSocket();
  const vite = await createViteServer({
    root: cwd,
    logLevel: "silent",
    plugins: [preact(), pkgResolverPlugin],
    resolve: { dedupe: ["preact", "@preact/signals"] },
    ssr: { noExternal: [pkg.name as string] },
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
