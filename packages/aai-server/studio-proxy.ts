// Copyright 2026 the AAI authors. MIT license.
/**
 * Reverse proxy from the agent service to the standalone studio service.
 *
 * The split deployment keeps ONE public origin: browsers talk to the agent
 * service, which forwards the studio surface (`/`, `/favicon.ico`,
 * `/studio-assets/*`, `/studio/*`) to the studio service's internal URL.
 * This is what preserves the preview iframe — agent pages are served with
 * `X-Frame-Options: SAMEORIGIN`, so the studio must share their origin —
 * and keeps the studio's bearer keys off a second public hostname.
 *
 * The studio API is plain HTTP plus SSE (`POST /studio/chat` streams the AI
 * SDK UI-message stream); it has no WebSockets, so a streaming `fetch`
 * passthrough covers all of it. Two encoding details are load-bearing:
 *
 * - The forwarded request drops `accept-encoding`, so the upstream answers
 *   with an identity body. undici's fetch transparently decompresses
 *   compressed responses but leaves the `content-encoding`/`content-length`
 *   headers in place — re-serving those headers with a decompressed body
 *   corrupts the response. Identity end-to-end sidesteps the whole class.
 * - The response is re-streamed (`res.body` passthrough), never buffered:
 *   chat turns are long-lived SSE streams and the client renders tokens as
 *   they arrive.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { Context } from "hono";
import type { HonoEnv } from "./context.ts";
import { publicForwardedHeaders } from "./public-origin.ts";

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) plus the ones the proxy must own:
 * `host` names the upstream (undici derives it from the target URL), and
 * `accept-encoding` is dropped per the module doc.
 */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/**
 * The studio surface, as one predicate. Single source of truth for every
 * consumer that must agree on it: the orchestrator's proxy registration
 * (split mode) and the combined entry's path dispatcher
 * (aai-studio-server/index.ts). Adding a studio path means editing this and
 * the studio app's routes — nothing else.
 */
export function isStudioPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/favicon.ico" ||
    pathname === "/studio" ||
    pathname.startsWith("/studio/") ||
    pathname.startsWith("/studio-assets/")
  );
}

export type StudioProxy = (c: Context<HonoEnv>) => Promise<Response>;

/**
 * The forwarded request's headers: the inbound set minus the hop-by-hop ones,
 * plus the public origin. The studio service needs the PUBLIC origin (this
 * service's), not its own upstream address — Publish hands it to the guest's
 * `aai deploy` as the platform to dial (see studio-routes'
 * requestPublicOrigin). Resolved rather than copied off the request URL: this
 * service is itself reached over cleartext behind Modal's TLS termination, so
 * forwarding `url.protocol` told the studio the platform was `http://`.
 */
function forwardRequestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    // Headers iteration yields lowercased names per the Fetch spec.
    if (!STRIP_REQUEST_HEADERS.has(name)) headers.set(name, value);
  }
  const forwarded = publicForwardedHeaders(req);
  headers.set("x-forwarded-host", forwarded.host);
  headers.set("x-forwarded-proto", forwarded.proto);
  return headers;
}

/** The upstream response's headers minus the ones re-streaming invalidates. */
function relayResponseHeaders(res: Response): Headers {
  const headers = new Headers();
  for (const [name, value] of res.headers) {
    if (!STRIP_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * Build the proxy handler. `fetchFn` is injectable for tests; production
 * uses the global fetch — the upstream URL is operator config (the studio
 * service's own address), never request-derived, so no SSRF surface.
 */
export function createStudioProxy(
  upstream: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): StudioProxy {
  // Normalize once: no trailing slash, so path concatenation is exact.
  const base = upstream.replace(/\/+$/, "");

  return async (c) => {
    const url = new URL(c.req.url);
    const target = `${base}${url.pathname}${url.search}`;

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit = {
      method,
      headers: forwardRequestHeaders(c.req.raw),
      // Pass upstream redirects through to the browser (the studio app
      // redirects /studio/ → /) instead of following them proxy-side.
      redirect: "manual",
      // Propagate client disconnect to the upstream. Without this the studio
      // surface's long-lived streams — the SSE event routes and chat turns —
      // outlive the browser that asked for them: the inbound request dies,
      // its response stream is dropped, and the upstream keeps producing
      // forever, holding a Supabase Realtime watcher and re-reading its row
      // on every change. `@hono/node-server` aborts this signal ONLY when
      // the response socket closes before it finished (its `makeCloseHandler`
      // checks `writableFinished`), so a normally-completing response — a
      // fully-drained SSE stream included — is never cut short by it.
      signal: c.req.raw.signal,
      ...(hasBody && { body: c.req.raw.body, duplex: "half" }),
      // `duplex` is required for streaming request bodies and absent from
      // the DOM lib's RequestInit type; undici (Node's fetch) honors it.
    } as RequestInit;

    let res: Response;
    try {
      res = await fetchFn(target, init);
    } catch (err) {
      // A client that hung up aborts the signal above, which surfaces here as
      // a fetch rejection. That is the expected end of every SSE stream — not
      // an upstream fault — so it must not log or report the studio as down.
      // Nobody is left to read it; the response only settles the handler, so
      // it is built raw rather than through `c.json` — 499 (nginx's
      // client-closed-request) is outside Hono's typed status union.
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      console.error(`Studio proxy request failed: ${errorMessage(err)}`);
      return c.json({ error: "Studio is unavailable — try again shortly" }, 502);
    }

    return new Response(res.body, { status: res.status, headers: relayResponseHeaders(res) });
  };
}
