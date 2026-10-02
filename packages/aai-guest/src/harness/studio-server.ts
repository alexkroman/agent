// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio mode's HTTP surface: the harness's OWN routes, and everything else
 * handed to the loaded bundle's server.
 *
 * The harness carries no runtime ("User-shipped runtime" in this package's
 * guide), so studio mode cannot be a `createServerForRuntime` with hooks the way
 * agent mode is. It is a plain `node:http` server that answers the control
 * channel (`/ws`), session-init and the chat routes itself, and forwards every
 * other request and upgrade to the preview server the LOADED bundle's runtime
 * built (`studio-preview.ts`). Before any bundle loads it answers `/health`
 * (the host's readiness probe) and refuses the rest with a 503.
 *
 * @module
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { errorMessage } from "@alexkroman1/aai";
import { requestPath } from "@alexkroman1/aai/internal";
import { verifyBearer } from "aai-guest-core/auth";
import type { StudioPreview } from "./studio-preview.ts";

/** What the studio server is built from. */
export type StudioServerDeps = {
  /** The per-sandbox bearer the control channel is gated by. */
  token: string;
  /** The harness's own HTTP routes; `true` when one answered. */
  handleOwn: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => boolean;
  /** The loaded bundle's server, when there is one. */
  preview: StudioPreview;
  /** Whether a host control connection is already open (one per harness). */
  hostConnected: () => boolean;
  /** Complete an authenticated `/ws` upgrade. */
  acceptControl: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
};

/** Refuse an upgrade with a bare status line. */
function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

/** See the module doc. Not listening: the caller binds it. */
export function createStudioServer(deps: StudioServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = requestPath(req.url);
    const method = req.method ?? "GET";
    if (deps.handleOwn(req, res, url, method)) return;
    const target = deps.preview.current();
    if (target) {
      target.node.emit("request", req, res);
      return;
    }
    // No bundle loaded yet: the harness is up, and there is no agent to describe.
    const health = url === "/health";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.writeHead(health ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health ? { status: "ok" } : { error: "No agent loaded" }));
  });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (requestPath(req.url) !== "/ws") {
      const target = deps.preview.current();
      if (target) target.node.emit("upgrade", req, socket, head);
      else refuse(socket, "503 Service Unavailable");
      return;
    }
    // The control channel: the tunnel URL is public — an upgrade without the
    // per-sandbox bearer token is rejected before the handshake.
    if (!verifyBearer(req.headers.authorization, deps.token)) {
      refuse(socket, "401 Unauthorized");
      return;
    }
    // One host per harness: a second authenticated dial would interleave two
    // hosts' RPC streams. The host never redials a live sandbox.
    if (deps.hostConnected()) {
      refuse(socket, "409 Conflict");
      return;
    }
    deps.acceptControl(req, socket, head);
  });
  return server;
}

/**
 * Studio mode's span export, through the PLATFORM's runtime — the one the coding
 * agent runs on — loaded DYNAMICALLY so agent mode never imports it. A no-op that
 * imports nothing further when no collector is configured. Never rejects: a
 * missing tracing module costs spans, not the sandbox.
 */
export async function startStudioTracing(
  load: () => Promise<{ startTracingDetached: () => void }> = () =>
    import("@alexkroman1/aai-runtime/tracing"),
): Promise<void> {
  try {
    (await load()).startTracingDetached();
  } catch (err) {
    console.error(`studio tracing unavailable: ${errorMessage(err)}`);
  }
}
