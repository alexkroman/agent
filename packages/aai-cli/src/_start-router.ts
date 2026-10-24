// Copyright 2026 the AAI authors. MIT license.
/**
 * The `aai start --workers` primary's public listener: route each request to
 * the worker its affinity key names (`_start-affinity.ts`).
 *
 * Two kinds of traffic, routed at two layers on purpose:
 *
 * - **A WebSocket upgrade** (`/websocket`, `/inbox`, `/phone`) is handed to the
 *   worker as the raw socket, with the request bytes replayed. After the
 *   handoff the primary never touches the connection again — every audio frame
 *   goes straight to the worker, so the primary cannot become the bottleneck
 *   the workers exist to remove.
 * - **Plain HTTP** (`/api/*`, `/workflows/*`, `/client-config`, …) is proxied
 *   PER REQUEST to the worker's private loopback port. Routing per connection
 *   would be wrong behind any reverse proxy that pools upstream connections:
 *   many clients share one keep-alive connection, and every request on it would
 *   follow the first. This traffic is light, so the proxy hop is cheap.
 *
 * A keyed request whose worker is restarting gets `503` with `Retry-After`
 * rather than another worker: the session it names lives only in its own
 * worker, and a client retrying in a second beats one silently forked.
 *
 * @module
 */

import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import { affinityKey, isCallPath, isResume, slotOf } from "./_start-affinity.ts";
import type { ReadyWorker, WorkerStatus } from "./_start-workers.ts";

/** How long a client may take to send its request head before it is dropped. */
export const HEADERS_TIMEOUT_MS = 15_000;

/** Headers that describe ONE hop and must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name)) out[name] = value;
  }
  return out;
}

/** The request head, re-serialized byte-for-byte from what the parser saw, for a handoff. */
export function serializeRequestHead(req: IncomingMessage): Buffer {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) head += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return Buffer.from(`${head}\r\n`, "latin1");
}

/** What the router needs from the supervisor. */
export interface RouterOptions {
  slots: number;
  target(slot: number): ReadyWorker | undefined;
  /** How a request reaches a worker — `http.request` unless a spec says otherwise. */
  request?: UpstreamRequest;
  /** May a NEW call go to this slot's worker now? Unset: always. */
  admitCall?: (slot: number) => "ok" | "draining" | "full";
  /** Count a call handed to the slot's worker before its next load report. */
  reserveCall?: (slot: number) => void;
  /** Per-worker state for `GET /workers` (loopback only). Unset: no such route. */
  status?: () => WorkerStatus[];
}

/** Why a new call is refused, as the 503 body says it. */
const REFUSAL: Record<"draining" | "full", string> = {
  draining: "server is draining for a restart; retry against another instance",
  full: "this worker is at its call limit; retry shortly",
};

/** Loopback peers — the only ones `GET /workers` answers. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The slice of `http.request` the proxy uses: options, a reply callback, a writable body. */
export type UpstreamRequest = (
  options: http.RequestOptions,
  onReply: (reply: IncomingMessage) => void,
) => Writable;

/**
 * Pick the slot for a request: its key's slot when it has a key (and only that
 * slot — `undefined` while it restarts), else the next listening slot in turn.
 */
export function createSlotPicker(
  opts: RouterOptions,
): (key: string | undefined) => number | undefined {
  let next = 0;
  return (key) => {
    if (key !== undefined) {
      const slot = slotOf(key, opts.slots);
      return opts.target(slot) ? slot : undefined;
    }
    for (let i = 0; i < opts.slots; i++) {
      const slot = (next + i) % opts.slots;
      if (opts.target(slot)) {
        next = slot + 1;
        return slot;
      }
    }
  };
}

function unavailable(res: ServerResponse): void {
  res.writeHead(503, { "retry-after": "1", "content-type": "text/plain" });
  res.end("worker restarting, retry shortly\n");
}

function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  worker: ReadyWorker,
  request: UpstreamRequest,
): void {
  const upstream = request(
    {
      host: "127.0.0.1",
      port: worker.port,
      method: req.method,
      path: req.url,
      headers: endToEnd(req.headers),
    },
    (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.statusMessage, endToEnd(reply.headers));
      reply.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end();
  });
  // The client went away mid-request (or mid-stream, e.g. a run's SSE): stop
  // the upstream request rather than letting it run for nobody.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function refuseUpgrade(socket: Socket, reason = "worker restarting, retry shortly"): void {
  const body = `${reason}\n`;
  socket.end(
    "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n" +
      `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/** The primary's public server. The caller binds it. */
export function createRouter(opts: RouterOptions): http.Server {
  const pick = createSlotPicker(opts);
  const server = http.createServer((req, res) => {
    if (opts.status && req.method === "GET" && req.url === "/workers") {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workers: opts.status() }));
      return;
    }
    const slot = pick(affinityKey(req.url, req.headers));
    const worker = slot === undefined ? undefined : opts.target(slot);
    if (!worker) return unavailable(res);
    proxy(req, res, worker, opts.request ?? http.request);
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const slot = pick(affinityKey(req.url, req.headers));
    const worker = slot === undefined ? undefined : opts.target(slot);
    if (slot === undefined || !worker) return refuseUpgrade(socket);
    const path = new URL(req.url ?? "/", "http://route.invalid").pathname;
    // Admission applies to a NEW call only: a reconnect continues a call that
    // is already counted, and an `/inbox` socket is not a call.
    const newCall = isCallPath(path) && !isResume(req.url, req.headers);
    if (newCall) {
      const verdict = opts.admitCall?.(slot) ?? "ok";
      if (verdict !== "ok") return refuseUpgrade(socket, REFUSAL[verdict]);
    }
    const bytes = Buffer.concat([serializeRequestHead(req), head]);
    worker.worker.send({ type: "aai-start:upgrade", bytes }, socket);
    if (newCall) opts.reserveCall?.(slot);
  });
  return server;
}
