// Copyright 2025 the AAI authors. MIT license.

import { createServer as createViteServer } from "vite";
import { DOMParser, installDomShim } from "../ui/_dom_shim.ts";
import { installMockWebSocket } from "./_mock_ws.ts";

/**
 * Smoke-test a client.tsx by loading it via Vite SSR in a DOM-shimmed
 * environment. The module's top-level `mount()` call executes as a side
 * effect; if it throws, the client code has a render-time bug.
 */
export async function renderCheck(clientEntry: string, cwd: string): Promise<void> {
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

  const mock = installMockWebSocket();
  const vite = await createViteServer({
    root: cwd,
    logLevel: "silent",
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
