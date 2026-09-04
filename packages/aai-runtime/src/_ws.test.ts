// Copyright 2026 the AAI authors. MIT license.
/** Provider-facing WebSocket construction: see PROVIDER_WS_OPTIONS. */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { defaultCreateHeaderWebSocket, PROVIDER_WS_OPTIONS } from "./_ws.ts";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/**
 * Stand up a server that ACCEPTS permessage-deflate and report which
 * extensions each accepted socket negotiated.
 */
async function startDeflatingServer(): Promise<{ port: number; negotiated: string[] }> {
  const negotiated: string[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => undefined);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => undefined);
      negotiated.push(Object.keys(ws.extensions).join(",") || "none");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup = async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { port: (server.address() as AddressInfo).port, negotiated };
}

test("PROVIDER_WS_OPTIONS disables permessage-deflate", () => {
  // `ws` defaults this to TRUE on clients, so the option must be explicit —
  // an empty object here would silently restore compression.
  expect(PROVIDER_WS_OPTIONS.perMessageDeflate).toBe(false);
});

test("defaultCreateHeaderWebSocket declines compression even when the peer offers it", async () => {
  const { port, negotiated } = await startDeflatingServer();

  const ws = defaultCreateHeaderWebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { Authorization: "Bearer test" },
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(e.message ?? "ws error")));
  });

  // The negotiated extension set is the observable that matters: a zlib
  // context per socket is what "permessage-deflate" costs us (+321 KiB RSS
  // and ~4.5x CPU per socket, measured), so assert the wire result rather
  // than the option we passed in.
  expect(negotiated).toEqual(["none"]);
  ws.close(1000);
});
