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
import { requestPath } from "@alexkroman1/aai/internal";
import { isRecord } from "@alexkroman1/aai/utils";
import { routeMatches, SERVER_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { affinityKey, isCallPath, isResume, slotOf } from "./_start-affinity.ts";
import type { Admission, ReadyWorker, WorkerStatus } from "./_start-workers.ts";

/** How long a client may take to send its request head before it is dropped. */
export const HEADERS_TIMEOUT_MS = 15_000;

/**
 * How often the server sweeps for connections past {@link HEADERS_TIMEOUT_MS}.
 * Node's default is 30 s, so a slow-headers client actually held its socket
 * for 15–45 s (measured: 2000 idle half-sent heads all still open at 18 s).
 */
export const CONNECTIONS_CHECK_MS = 2000;

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
  /**
   * May this call socket go to the slot's worker now? `"ok"` also COUNTS it
   * (`SupervisedWorkers.admit`). `resume` is the client's claim that it
   * continues a live call (see `isResume`). Unset: always.
   */
  admitCall?: (slot: number, resume: boolean) => Admission;
  /**
   * Why this server should be out of a load balancer's rotation right now
   * (starting, draining), or `undefined` when it should be in. A reason makes
   * the primary answer `/health` itself with 503 instead of proxying it.
   */
  notReady?: () => string | undefined;
  /** Per-worker state for `GET /workers` (loopback only). Unset: no such route. */
  status?: () => WorkerStatus[];
}

/** Why a new call is refused, as the 503 body says it. */
const REFUSAL: Record<Exclude<Admission, "ok">, string> = {
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
 * Pick the worker for a request: its key's slot when it has a key (and only
 * that slot — `undefined` while it restarts), else the next listening slot in turn.
 */
export function createSlotPicker(
  opts: Pick<RouterOptions, "slots" | "target">,
): (key: string | undefined) => { slot: number; worker: ReadyWorker } | undefined {
  let next = 0;
  const at = (slot: number) => {
    const worker = opts.target(slot);
    return worker && { slot, worker };
  };
  return (key) => {
    if (key !== undefined) return at(slotOf(key, opts.slots));
    for (let i = 0; i < opts.slots; i++) {
      const picked = at((next + i) % opts.slots);
      if (picked) {
        next = picked.slot + 1;
        return picked;
      }
    }
  };
}

function unavailable(res: ServerResponse, reason = "worker restarting, retry shortly"): void {
  res.writeHead(503, { "retry-after": "1", "content-type": "text/plain" });
  res.end(`${reason}\n`);
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
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" }).end();
      return;
    }
    // Mid-body (a worker died streaming an SSE run or a large /api reply): a
    // clean end would hand the client a truncated body that looks complete.
    res.destroy();
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

/**
 * Stop THIS process reading `socket` before its handle goes to a worker.
 *
 * Node leaves the handle reading after an upgrade, and the IPC send detaches
 * it only when the send actually happens — after the ack of every handle
 * queued ahead of it — then closes it only on this one's ack. Bytes the client
 * sends meanwhile (a client that writes before the 101, or simply racing the
 * ack) are read HERE and dropped, and the worker sees a stream with a hole in
 * it: a corrupt WebSocket frame. Measured with real IPC and pipelining
 * clients: 12–23 of 300 concurrent handoffs lost bytes; with this, none of
 * 3000. `pause()` is no
 * substitute — it stops the stream, not the handle. Stopped, the bytes wait in
 * the kernel for the worker's own read.
 */
export function stopReading(socket: Socket): void {
  // `_handle` is Node's (untyped) libuv stream; there is no public readStop.
  const handle: unknown = Reflect.get(socket, "_handle");
  if (isRecord(handle) && typeof handle.readStop === "function") handle.readStop();
}

/** A load balancer's probe: `GET`/`HEAD` on the server's own health route. */
function isHealthProbe(req: IncomingMessage): boolean {
  const { health } = SERVER_ROUTES;
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    routeMatches(health, requestPath(req.url ?? "/"))
  );
}

/** The primary's public server. The caller binds it. */
export function createRouter(opts: RouterOptions): http.Server {
  const pick = createSlotPicker(opts);
  const server = http.createServer(
    { connectionsCheckingInterval: CONNECTIONS_CHECK_MS },
    (req, res) => {
      if (opts.status && req.method === "GET" && req.url === "/workers") {
        if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workers: opts.status() }));
        return;
      }
      // Readiness is the PRIMARY's to answer: while it starts or drains, a
      // worker's own 200 would keep it in a load balancer's rotation.
      const notReady = opts.notReady?.();
      if (notReady && isHealthProbe(req)) return unavailable(res, notReady);
      const picked = pick(affinityKey(req.url, req.headers));
      if (!picked) return unavailable(res);
      proxy(req, res, picked.worker, opts.request ?? http.request);
    },
  );
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const picked = pick(affinityKey(req.url, req.headers));
    if (!picked) return refuseUpgrade(socket);
    // Admission applies to CALL sockets only — an `/inbox` socket is not one.
    const call = isCallPath(req.url);
    if (call) {
      const verdict = opts.admitCall?.(picked.slot, isResume(req.url, req.headers)) ?? "ok";
      if (verdict !== "ok") return refuseUpgrade(socket, REFUSAL[verdict]);
    }
    const bytes = Buffer.concat([serializeRequestHead(req), head]);
    stopReading(socket);
    // The worker died since it was picked: the handle never left, so answer
    // the client here rather than leave its socket unread and unanswered.
    if (!picked.worker.worker.send({ type: "aai-start:upgrade", bytes, call }, socket)) {
      refuseUpgrade(socket);
    }
  });
  return server;
}
