import { omitUndefined } from "@alexkroman1/aai/utils";
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
 * **One DIRECTION of one route deliberately passes more, and says why.** The
 * durable-run webhook delivers a THIRD PARTY's request into the run:
 * `resumeWebhook` hands the whole `Request` to `resumeHook`, which dehydrates it
 * as the hook's payload, so a workflow verifying `Stripe-Signature` /
 * `X-Hub-Signature-256` needs headers this module cannot enumerate.
 * Allow-listing there would break the feature's headline use case (a payment
 * callback) while an unknown provider header silently disappeared. So that
 * route's REQUEST uses {@link passThroughHeaders}, whose strip set is
 * {@link NEVER_FORWARDED} — the hop-by-hop headers PLUS the three
 * credential-bearing ones above, which is the same rule the allow-list encodes,
 * read from the other end.
 *
 * **Its RESPONSE does not.** Both directions of both hops are allow-lists now
 * ({@link GUEST_API_RESPONSE_HEADERS}, {@link GUEST_WEBHOOK_RESPONSE_HEADERS}),
 * and the asymmetry is what the two callers really are: the request carries a
 * message from a sender nobody enumerated, while the response is read by a
 * webhook sender that looks at a status code. The deny-list this replaced is
 * argued at {@link GUEST_WEBHOOK_RESPONSE_HEADERS} — including the three
 * origin-scoped headers it had never heard of, which is what a deny-list costs.
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
 *
 * **`Retry-After` was missing, and the guest is the one that MINTS it.**
 * `aai-runtime/workflow-api-error-status.ts` is an entire deliberate taxonomy of
 * which 5xx carries a delay and which does not — a saturated connection pool, an
 * exhausted descriptor table and a failed hop out of the sandbox each answer
 * `503` with `Retry-After: 1`, while a full disk answers `507` with none, and
 * that ABSENCE is as much a signal as the value. `workflow-api.ts` sets the
 * header; this hop dropped it, so every one of those decisions arrived at a
 * deployed caller as a bare status. The readers are real and already written:
 * `aai/sdk/step-retry.ts`'s `retryAfter()` and `sdk/_upload-retry.ts`, which a
 * browser uploading parts through `/:slug/workflows/uploads` runs on every
 * refusal — "the far side knows something this does not" is that module's own
 * argument for preferring it, and the far side was being censored.
 *
 * It is also the one name this list and {@link GUEST_WEBHOOK_RESPONSE_HEADERS}
 * now share beyond `Content-Type`, and the two still do NOT merge. Their union
 * is not either policy: this hop must carry the range and streaming headers, and
 * the webhook hop must not (the platform buffers that reply, so a length or an
 * encoding would describe bytes the runtime re-frames). Their intersection is
 * not either policy either — it would drop `Content-Range`, which is the whole
 * point of the `Range` request half. One list is one AUDIENCE, and there are two.
 */
export const GUEST_API_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "x-accel-buffering",
  "retry-after",
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

/**
 * Response headers returned from the durable-run webhook hop.
 *
 * ## Why this direction is an ALLOW-LIST
 *
 * A header the guest sets on this hop is a TENANT statement made in the
 * platform's own voice: agent pages and the studio share one origin today, and
 * `packages/aai-studio-client/CLAUDE.md` records that the origin split is owed —
 * so anything persisted or origin-scoped is a thing one tenant could otherwise
 * say about every other tenant and about the studio itself.
 *
 * This was a deny-list of 19 names, assembled from the criterion "does it scope
 * to the ORIGIN, or outlive the response?" — `set-cookie`, `clear-site-data`,
 * `alt-svc`, `strict-transport-security`, the reporting destinations, CSP,
 * `www-authenticate`, and so on. Two things about that shape, and the second is
 * the one that decided it:
 *
 * - **A deny-list has to be re-audited whenever the web platform ships another
 *   persisted origin-scoped header.** `clear-site-data`, `set-login` and
 *   `reporting-endpoints` all post-date `set-cookie`. An allow-list only needs
 *   editing when a FEATURE wants something.
 * - **It was already out of date, demonstrably.** Three headers a browser
 *   honours crossed this hop: `Refresh: 0; url=…` (a redirect under another
 *   name, so the deliberate `location` exclusion below was leaking its own
 *   mirror image), `Speculation-Rules` (names a JSON document of URLs the
 *   browser then FETCHES), and `Integrity-Policy` (document policy, with a
 *   tenant-chosen reporting endpoint). Nobody had heard of them, which is
 *   precisely the failure mode — `guest-forward.test.ts` carries that as a
 *   failing-first observation.
 *
 * ## What a webhook sender actually reads, which is all this carries
 *
 * `Content-Type`, so the body it logs or shows in a dashboard is interpretable,
 * and `Retry-After`, so a tenant answering 429/503 can steer the sender's own
 * retry loop. Nothing else has a reader: the platform buffers the reply
 * (`workflow-webhook-handler.ts`), so `Content-Length` is framed by the runtime
 * and `Content-Encoding` would describe bytes `fetch` has already decoded.
 *
 * ## `location` is OMITTED, and that is the decision this list makes
 *
 * A tenant 302 relayed through the platform origin is an open redirect wearing
 * the platform's hostname. Under a deny-list, keeping it was defensible on the
 * ground that a redirect scopes to its own response and today's caller is a
 * third-party webhook sender with no address bar — but that ground is a claim
 * about the CALLER SET, and the guide above says the origin split is owed, i.e.
 * the caller set is expected to change. `Refresh` crossing unnoticed is what the
 * claim costs in practice.
 *
 * **What omitting it breaks**, stated so the trade is reviewable: a tenant whose
 * webhook endpoint answers 3xx now has its `Location` dropped, so the sender
 * sees a bodiless redirect status it cannot follow. That is narrow — the DevKit's
 * own webhook resume answers 200/204, and a webhook endpoint that redirects is
 * answering the wrong question — and it is one entry away from being restored
 * the day a feature asks, which is the whole argument for this shape. Restoring
 * it while a BROWSER can reach this hop is the thing to refuse.
 */
export const GUEST_WEBHOOK_RESPONSE_HEADERS = ["content-type", "retry-after"] as const;

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
 * Copy everything except {@link NEVER_FORWARDED} (and every `x-forwarded-*`)
 * into a fresh `Headers`. For the one DIRECTION of one hop that must carry
 * headers this module cannot name — see the module doc.
 *
 * The strip set used to be a parameter, and its only other argument was the
 * response deny-list this file no longer has. A seam with one caller is a seam
 * that reads as a policy choice, and the policy here is that there is exactly
 * one pass-through and exactly one reason for it.
 */
export function passThroughHeaders(from: Headers): Headers {
  const headers = new Headers();
  from.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (NEVER_FORWARDED.has(lower) || lower.startsWith("x-forwarded-")) return;
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
   * The window once the request body has started MOVING. Defaults to
   * `timeoutMs`, and only `"activity"` reads it.
   *
   * Its own number because what it waits on is unobservable from here. A pull
   * stall means undici's write buffer is full, and that buffer empties at the
   * GUEST's pace — so both the wait for room for one more chunk and the wait for
   * an answer after the last byte are really claims about the guest's write
   * bandwidth, not about a round trip. See
   * `WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS`, whose doc carries the measurement and
   * the 27 production 503s that named this.
   */
  transferTimeoutMs?: number | undefined;
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
   *
   * `"activity"` is `"headers"` plus a re-arm on every chunk of the REQUEST
   * body that drains, and it is what any route forwarding a STREAMING body
   * wants. Both of the other two bound the head, and a route whose guest
   * answers only after consuming the whole body therefore has the entire
   * upload inside its deadline — `POST /workflows/uploads` accepts 2 GiB
   * (`MAX_WORKFLOW_UPLOAD_BYTES`) and answers 201 once the last byte is
   * stored, so under `"headers"` a 500 MB file needed ~133 Mbps of sustained
   * upstream to beat a 30s deadline and was otherwise aborted mid-transfer.
   * There is no total that is right for that: the ceiling is the caller's
   * bandwidth, which this hop cannot see. What it CAN see is progress, so the
   * deadline becomes "no chunk drained for `timeoutMs`" — a stalled guest
   * still fails on time, and a slow-but-moving upload never does.
   */
  bound?: "headers" | "response" | "activity";
};

/**
 * Re-emit a request body, calling `onProgress` as each chunk is consumed.
 *
 * The consumer is undici writing to the socket, which reads under backpressure
 * — so a `pull` is evidence the transfer is MOVING, which is what makes this a
 * progress signal and not a clock. What a pull is NOT is proof the chunk reached
 * the far end, and this doc claimed it was: measured against a real reader that
 * consumed 64 KB every 200ms, undici took 5 MiB of body in 10ms and the reader
 * had 0.6 MiB of it. So the pulls run AHEAD of the wire by whatever the socket
 * and undici's own write buffer hold, and a pull STALL means that buffer is full
 * rather than that anything is wrong — which is why what a pull re-arms is
 * `transferTimeoutMs` and not the head budget.
 */
function trackBodyProgress<T>(body: ReadableStream<T>, onProgress: () => void): ReadableStream<T> {
  const reader = body.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      const { done, value } = await reader.read();
      onProgress();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      // The forward was abandoned (the deadline fired, or the platform's own
      // caller went away). Without this the source stream — the inbound
      // request's body — is left unread with nobody to drain it.
      return reader.cancel(reason);
    },
  });
}

/**
 * Forward one request to a guest, bounded.
 *
 * Rejects with whatever `fetch` rejected with (an abort included) — the three
 * callers answer differently (a degraded `{}`, a 503, a 502), and inventing a
 * fourth taxonomy here would put the decision two modules away from the route
 * that has to make it.
 */
export async function forwardToGuest(opts: GuestForwardOptions): Promise<Response> {
  const bound = opts.bound ?? "response";
  // Two mechanisms, because the deadline means two different things. A
  // hand-held timer can be DISARMED the moment the head arrives — and, under
  // `"activity"`, RE-ARMED as the request body moves — which is the only way to
  // leave a legitimately endless body alone; `AbortSignal.timeout` cannot be,
  // which is exactly what a caller that buffers the whole response wants — the
  // body read is inside the budget rather than unbounded after it.
  const controller = bound === "response" ? undefined : new AbortController();
  const transferMs = opts.transferTimeoutMs ?? opts.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number = opts.timeoutMs): void => {
    if (!controller) return;
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  arm();
  // Only a STREAM can report progress; a buffered body is handed over whole, so
  // under `"activity"` it behaves exactly as `"headers"` does — which is why the
  // one caller on this bound passes it for every method rather than branching.
  const body =
    bound === "activity" && opts.body instanceof ReadableStream
      ? trackBodyProgress(opts.body, () => arm(transferMs))
      : opts.body;
  try {
    return await opts.fetchFn(opts.url, {
      method: opts.method ?? "GET",
      ...omitUndefined({ headers: opts.headers }),
      // `duplex: "half"` is REQUIRED whenever the body is a stream — undici
      // rejects the request outright rather than buffering it, which is the
      // trade we want but not one it may assume.
      ...(body ? { body, duplex: "half" } : {}),
      signal: controller?.signal ?? AbortSignal.timeout(opts.timeoutMs),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
