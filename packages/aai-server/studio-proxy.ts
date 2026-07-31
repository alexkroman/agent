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

export type StudioProxy = (c: Context<HonoEnv>) => Promise<Response>;

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

    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) {
      if (!STRIP_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit = {
      method,
      headers,
      // Pass upstream redirects through to the browser (the studio app
      // redirects /studio/ → /) instead of following them proxy-side.
      redirect: "manual",
      ...(hasBody && { body: c.req.raw.body, duplex: "half" }),
      // `duplex` is required for streaming request bodies and absent from
      // the DOM lib's RequestInit type; undici (Node's fetch) honors it.
    } as RequestInit;

    let res: Response;
    try {
      res = await fetchFn(target, init);
    } catch (err) {
      console.error(`Studio proxy request failed: ${errorMessage(err)}`);
      return c.json({ error: "Studio is unavailable — try again shortly" }, 502);
    }

    const responseHeaders = new Headers();
    for (const [name, value] of res.headers) {
      if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    }
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  };
}
