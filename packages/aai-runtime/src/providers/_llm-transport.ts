// Copyright 2026 the AAI authors. MIT license.
/**
 * The transport every model-provider request rides: Node's own `fetch`
 * semantics, with idle connections kept 30 s (`modelFetch`, the egress module's
 * model pool) instead of undici's 4 s.
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
 * `modelFetch` (`pinnedFetch` on that pool) — but ONLY while the global is still Node's own, judged per call
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
 * @module
 */

import { modelFetch } from "../_egress-fetch.ts";
import type { FetchLike } from "./_request-body-extras.ts";

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

/** `check`, answered again only when the function it is asked about changes. */
function lastVerdict(check: (fetch: FetchLike) => boolean): (fetch: FetchLike) => boolean {
  let last: FetchLike | undefined;
  let verdict = false;
  return (fetch) => {
    if (fetch !== last) {
      last = fetch;
      verdict = check(fetch);
    }
    return verdict;
  };
}

/** The real provider `fetch` — see the module doc. */
export const llmFetch: FetchLike = createLlmFetch({
  ambient: () => globalThis.fetch,
  isNative: lastVerdict(isNodeFetch),
  keepAlive: () => modelFetch,
});
