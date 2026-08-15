// Copyright 2026 the AAI authors. MIT license.
/**
 * The one platform→guest forward, and the one header policy it applies.
 *
 * Three routes proxy a request into a tenant's sandbox — `GET
 * /:slug/client-config`, `/:slug/workflows/*`, and the durable-run webhook —
 * and each had re-derived the same four steps: broker the guest, build its URL,
 * filter the headers, fetch with a deadline. The filters had drifted into three
 * different answers (an allow-list, a deny-list, and none at all), which is the
 * shape of divergence that only shows up as a security question much later.
 *
 * **The default policy is an ALLOW-LIST, because a header that crosses this hop
 * reaches tenant code.** `Cookie` is a credential for THIS origin — agent pages
 * and the studio are served from it — and `Authorization` is a platform bearer;
 * neither is part of the message, and forwarding them hands a caller's
 * credentials to whoever owns the slug in the URL. `X-Forwarded-*` describes
 * this hop, so passing it on makes the guest's view of its caller a description
 * of the platform.
 *
 * **One route deliberately passes more, and says why.** The durable-run webhook
 * delivers a THIRD PARTY's request into the run: `resumeWebhook` hands the whole
 * `Request` to `resumeHook`, which dehydrates it as the hook's payload, so a
 * workflow verifying `Stripe-Signature` / `X-Hub-Signature-256` needs headers
 * this module cannot enumerate. Allow-listing there would break the feature's
 * headline use case (a payment callback) while an unknown provider header
 * silently disappeared. So that one route uses {@link passThroughHeaders}, whose
 * strip set is {@link NEVER_FORWARDED} — the hop-by-hop headers PLUS the three
 * credential-bearing ones above, which is the same rule the allow-list encodes,
 * read from the other end.
 */

/**
 * Request headers forwarded on an API hop.
 *
 * `Authorization` is the only one carrying authority — the guest's own gate is
 * `AAI_WORKFLOW_API_TOKEN` — `Content-Type` is what makes the JSON body parse,
 * and `Accept` is what distinguishes an event-stream request. `Range` is what
 * makes `GET /workflows/uploads/:id` mean anything through this hop: dropped, a
 * caller asking for 64 KB of a 200 MB recording is answered with the whole
 * thing, correctly and uselessly.
 */
export const GUEST_API_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "range",
] as const;

/**
 * Response headers forwarded back from an API hop.
 *
 * Every route on that surface answers JSON, an event stream or an uploaded
 * file's bytes, so this is `Content-Type` plus the length when the guest
 * declared one, plus the two headers that keep a stream unbuffered end to end.
 * `Content-Encoding` and `Transfer-Encoding` are deliberately absent: `fetch`
 * has already decoded the body we are re-emitting, so echoing them would
 * describe bytes that no longer exist.
 */
export const GUEST_API_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "x-accel-buffering",
  // The `Range` half's answer. Without `Content-Range` a 206 is a partial body
  // a client cannot place, and without `Accept-Ranges` a client that probes
  // first never asks for a range at all.
  "content-range",
  "accept-ranges",
  "content-disposition",
] as const;

/**
 * Headers that must never cross into a guest, for {@link passThroughHeaders}.
 *
 * Two groups, and the second is the one that was missing. The hop-by-hop set
 * describes THIS connection rather than the message, plus the two the next hop
 * recomputes — forwarding `content-length` beside a body undici re-frames is how
 * a proxy invents a truncated request. The credential set (`cookie`,
 * `authorization`, and the `x-forwarded-*` prefix, matched separately below)
 * authenticates or describes the CALLER TO US, and tenant code is not us.
 */
export const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "expect",
  "host",
  "content-length",
  "cookie",
  "authorization",
]);

/** Response headers describing the guest→platform hop, for a pass-through reply. */
export const NEVER_RETURNED: ReadonlySet<string> = new Set([
  ...NEVER_FORWARDED,
  // `fetch` has already decoded the body, so passing this on would declare an
  // encoding the bytes no longer carry.
  "content-encoding",
]);

/** Copy an allow-listed subset of `from` into a fresh `Headers`. */
export function pickHeaders(from: Headers, names: readonly string[]): Headers {
  const picked = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
}

/**
 * Copy everything except `strip` (and every `x-forwarded-*`) into a fresh
 * `Headers`. For the one hop that must carry headers this module cannot name —
 * see the module doc.
 */
export function passThroughHeaders(
  from: Headers,
  strip: ReadonlySet<string> = NEVER_FORWARDED,
): Headers {
  const headers = new Headers();
  from.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (strip.has(lower) || lower.startsWith("x-forwarded-")) return;
    headers.append(lower, value);
  });
  return headers;
}

export type GuestForwardOptions = {
  /** Injectable so a spec can assert what crossed without standing a guest up. */
  fetchFn: typeof globalThis.fetch;
  url: string | URL;
  method?: string;
  headers?: Headers;
  body?: RequestInit["body"] | undefined;
  timeoutMs: number;
  /**
   * What the deadline covers.
   *
   * `"headers"` disarms it once the response head arrives, and is REQUIRED
   * wherever a route is legitimately endless: `GET /runs/:id/events` holds a
   * stream open for minutes, and a still-armed signal aborts it mid-body — the
   * truncated chunked response `live-streams.ts` exists to prevent, produced on
   * a healthy agent at a fixed interval and looking exactly like a network
   * fault. `"response"` (the default) keeps it armed over the body, which is
   * right wherever the caller buffers the whole thing.
   */
  bound?: "headers" | "response";
};

/**
 * Forward one request to a guest, bounded.
 *
 * Rejects with whatever `fetch` rejected with (an abort included) — the three
 * callers answer differently (a degraded `{}`, a 503, a 502), and inventing a
 * fourth taxonomy here would put the decision two modules away from the route
 * that has to make it.
 */
export async function forwardToGuest(opts: GuestForwardOptions): Promise<Response> {
  // Two mechanisms, because the deadline means two different things. A
  // hand-held timer can be DISARMED the moment the head arrives, which is the
  // only way to leave a legitimately endless body alone; `AbortSignal.timeout`
  // cannot be, which is exactly what a caller that buffers the whole response
  // wants — the body read is inside the budget rather than unbounded after it.
  const controller = opts.bound === "headers" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    return await opts.fetchFn(opts.url, {
      method: opts.method ?? "GET",
      ...(opts.headers ? { headers: opts.headers } : {}),
      // `duplex: "half"` is REQUIRED whenever the body is a stream — undici
      // rejects the request outright rather than buffering it, which is the
      // trade we want but not one it may assume.
      ...(opts.body ? { body: opts.body, duplex: "half" } : {}),
      signal: controller?.signal ?? AbortSignal.timeout(opts.timeoutMs),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
