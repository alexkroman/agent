// Copyright 2026 the AAI authors. MIT license.
/**
 * The transport every model-provider request rides: Node's own `fetch`
 * semantics, with idle connections kept {@link LLM_KEEP_ALIVE_MS} instead of
 * undici's 4 s.
 *
 * ## Why: a voice turn was paying a fresh TCP + TLS handshake
 *
 * undici keeps an idle connection for the server's `Keep-Alive: timeout=` hint,
 * or 4 s when there is none — and the AssemblyAI gateway (an AWS load balancer)
 * sends none. Turns are further apart than 4 s, so EVERY turn's model call
 * re-dialled: measured from a laptop, ~180 ms (TCP 88 + TLS 90) before the
 * request left, on a turn whose whole share of our code is ~10 ms. 30 s is the
 * runtime's own egress keep-alive (`EGRESS_KEEP_ALIVE_MS`) and under a load
 * balancer's 60 s idle default; a server that DOES send a hint still wins.
 *
 * ## Why not on `globalThis.fetch`
 *
 * The keep-alive is a dispatcher setting, and a dispatcher must ride the undici
 * copy it was built from: Node's bundled `fetch` is another major and rejects a
 * v8 `Agent` (`host/_undici.ts` in the SDK). So requests go through
 * `pinnedFetch` — but ONLY while the global is still Node's own, judged per call
 * by what the function IS (see {@link isNodeFetch}), not by identity with what
 * was there at load: an interceptor installed before this module loaded (a
 * test setup file's msw or nock) must still see every model request. When
 * anything has replaced it, the request goes to the replacement, as it always
 * did.
 *
 * No retry of its own. A reset can arrive AFTER the server read the request,
 * so re-sending would duplicate a billed generation; a stale idle connection is
 * rare at 30 s (the server's idle limit is longer) and the AI SDK's own retry
 * covers it.
 *
 * HTTP/1.1, as Node's bundled `fetch` speaks today: one streaming request per
 * connection, and the pool opens as many connections as there are calls in
 * flight — never a cap a busy process's turns would queue behind.
 *
 * @module
 */

import { pinnedFetch } from "@alexkroman1/aai/host-internal";
import { createEgressPool, type EgressPool } from "../_egress-pool.ts";
import type { FetchLike } from "./_request-body-extras.ts";

/** How long an idle model-provider connection is kept, absent a server hint. */
export const LLM_KEEP_ALIVE_MS = 30_000;

/**
 * Is `fetch` Node's own? Node's is a plain function whose source loads its
 * bundled undici; a wrapper has its own source and a `Proxy` prints as native
 * code, so neither matches. Wrong in the safe direction only: an unrecognized
 * `fetch` is used as it is, just without the keep-alive.
 */
export function isNodeFetch(fetch: FetchLike): boolean {
  return Function.prototype.toString.call(fetch).includes("internal/deps/undici");
}

/**
 * Can this request cross to `pinnedFetch` intact? undici 8 brand-checks a body
 * and a `Headers`/`Request` against ITS OWN classes, so a global one would be
 * stringified (`host/_undici.ts`). The AI SDK sends a URL string, a plain header
 * record and a string body; anything else keeps Node's `fetch`.
 */
export function isPlainRequest(input: string | URL | Request, init?: RequestInit): boolean {
  if (input instanceof Request || init?.headers instanceof Headers) return false;
  const body = init?.body;
  return (
    body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array
  );
}

/** What {@link createLlmFetch} is built from; the real ones unless a spec says otherwise. */
export interface LlmFetchDeps {
  /** The global as it is NOW — read on every call. */
  ambient: () => FetchLike;
  /** Is this `fetch` Node's own? */
  isNative: (fetch: FetchLike) => boolean;
  /** The keep-alive request, built on first use. */
  keepAlive: () => FetchLike;
}

/** The provider `fetch`: keep-alive while the global is Node's own and the request is plain, else the global. */
export function createLlmFetch(deps: LlmFetchDeps): FetchLike {
  return (input, init) => {
    const ambient = deps.ambient();
    if (!(deps.isNative(ambient) && isPlainRequest(input, init))) return ambient(input, init);
    return deps.keepAlive()(input, init);
  };
}

/** The process's one model-provider pool, built on first use; {@link closeLlmFetch} resets it. */
let pool: EgressPool | undefined;

function keepAliveFetch(): FetchLike {
  pool ??= createEgressPool({
    keepAliveTimeout: LLM_KEEP_ALIVE_MS,
    // HTTP/1.1, as Node's bundled `fetch` speaks today: one streaming request
    // per connection (`pipelining: 1`), and as many connections as there are
    // calls in flight — no cap a busy process's turns would queue behind.
    allowH2: false,
    pipelining: 1,
  });
  const { dispatcher } = pool;
  return (input, init) => pinnedFetch(input, { ...init, dispatcher });
}

/**
 * Close the model-provider pool, letting requests in flight finish. A later
 * request builds a fresh one, so a second runtime in the process is unharmed.
 */
export async function closeLlmFetch(): Promise<void> {
  const held = pool;
  pool = undefined;
  await held?.close();
}

/** The real provider `fetch` — see the module doc. */
export const llmFetch: FetchLike = createLlmFetch({
  ambient: () => globalThis.fetch,
  isNative: isNodeFetch,
  keepAlive: keepAliveFetch,
});
