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
 * passthrough covers all of it. The forwarding mechanics — hop-by-hop
 * header stripping (RFC 9110 §7.6.1), dropping `accept-encoding` so the
 * upstream answers identity (undici's fetch transparently decompresses
 * bodies but leaves `content-encoding`/`content-length` in place, so those
 * are stripped from an encoded response too), and re-streaming the response
 * body (never buffered — chat turns are long-lived SSE streams) — are
 * `hono/proxy`'s job.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { Context } from "hono";
import { proxy } from "hono/proxy";
import type { HonoEnv } from "./context.ts";
import { registerLiveStream } from "./live-streams.ts";
import { publicForwardedHeaders } from "./public-origin.ts";

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

    // The studio service needs the PUBLIC origin (this service's), not its
    // own upstream address — Publish hands it to the guest's `aai deploy`
    // as the platform to dial (see studio-routes' requestPublicOrigin).
    // Resolved rather than copied off `url`: this service is itself reached
    // over cleartext behind Modal's TLS termination, so forwarding
    // `url.protocol` told the studio the platform was `http://`.
    const forwarded = publicForwardedHeaders(c.req.raw);
    // The additions ride a wrapper Request rather than proxy()'s `headers`
    // option, which REPLACES the forwarded header set wholesale (dropping
    // authorization et al.). `host` is ours to delete — proxy() strips
    // hop-by-hop headers and `accept-encoding` but not `host`, and undici
    // derives it from the target URL.
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-forwarded-host", forwarded.host);
    headers.set("x-forwarded-proto", forwarded.proto);
    headers.delete("host");

    try {
      const res = await proxy(target, {
        raw: new Request(c.req.raw, { headers }),
        // Pass upstream redirects through to the browser (the studio app
        // redirects /studio/ → /) instead of following them proxy-side.
        redirect: "manual",
        customFetch: fetchFn,
      });
      return gracefulEventStream(res);
    } catch (err) {
      console.error(`Studio proxy request failed: ${errorMessage(err)}`);
      return c.json({ error: "Studio is unavailable — try again shortly" }, 502);
    }
  };
}

/**
 * Make a proxied SSE response endable at shutdown.
 *
 * The studio service ends its own streams gracefully (studio-sse.ts), which
 * covers a studio replica going down. This covers the other half: in split
 * mode the browser's connection terminates HERE, so an agent replica exiting
 * with a proxied stream open cuts the chunked body mid-frame — the same
 * `TransferEncodingError` Modal's proxy reports, from the other side of the
 * hop. Relaying through a stream we own lets shutdown close it, so the
 * terminating chunk goes out and the client resubscribes normally.
 *
 * Only `text/event-stream` is wrapped. Every other proxied response — the
 * studio bundle, JSON, assets — completes on its own and must stay a
 * zero-copy passthrough.
 */
function gracefulEventStream(res: Response): Response {
  const body = res.body;
  if (!(body && res.headers.get("content-type")?.includes("text/event-stream"))) return res;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const reader = body.getReader();
  const writer = writable.getWriter();
  const close = (): void => {
    void reader.cancel().catch(() => undefined);
    void writer.close().catch(() => undefined);
  };
  const unregister = registerLiveStream(close);

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch {
      // Upstream dropped; close below so the downstream body still ends.
    } finally {
      unregister();
      await writer.close().catch(() => undefined);
    }
  })();

  return new Response(readable, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
