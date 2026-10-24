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
 * `pinnedFetch` — but ONLY while the global is still Node's own. When something
 * has replaced it (the eval network, a spec's `vi.stubGlobal`), the request goes
 * to the replacement, read per call, as it always did.
 *
 * HTTP/1.1, as Node's bundled `fetch` speaks today: one streaming request per
 * connection, and the pool opens as many connections as there are calls in
 * flight — never a cap a busy process's turns would queue behind.
 *
 * @module
 */

import { asDispatcher, pinnedFetch } from "@alexkroman1/aai/host-internal";
import { Agent } from "undici";
import type { FetchLike } from "./_request-body-extras.ts";

/** How long an idle model-provider connection is kept, absent a server hint. */
export const LLM_KEEP_ALIVE_MS = 30_000;

/**
 * Node's own `fetch`, as found at load — an identity to compare against, so a
 * replaced global is noticed. Never called through this binding.
 */
const { fetch: NODE_FETCH } = globalThis;

/** Error codes that mean the connection died before any response: safe to re-send on a fresh one. */
const STALE_CONNECTION_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);

/** Did `error` come from a connection that was closed under the request? */
export function isStaleConnection(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  return code !== undefined && STALE_CONNECTION_CODES.has(code);
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
  /** Node's `fetch` from load time. */
  native: FetchLike;
  /** The keep-alive request, built on first use. */
  keepAlive: () => FetchLike;
}

/**
 * The provider `fetch`: keep-alive while the global is Node's own and the
 * request is plain, else the global.
 *
 * A request that fails because the server closed an idle connection just as
 * it was reused is re-sent ONCE, immediately — the AI SDK's own retry would
 * otherwise wait ~2 s on a voice turn. Only a connection-level failure, and
 * never after an abort: a response that started is never re-sent.
 */
export function createLlmFetch(deps: LlmFetchDeps): FetchLike {
  return async (input, init) => {
    const ambient = deps.ambient();
    if (ambient !== deps.native || !isPlainRequest(input, init)) return ambient(input, init);
    const send = deps.keepAlive();
    try {
      return await send(input, init);
    } catch (error) {
      if (!isStaleConnection(error) || init?.signal?.aborted) throw error;
      return send(input, init);
    }
  };
}

let agent: Agent | undefined;

/** `pinnedFetch` on the process's one keep-alive model-provider pool. */
function keepAliveFetch(): FetchLike {
  // Lazy: a process that never calls a model opens no pool. Idle undici
  // sockets are unref'd, so the pool never holds a process open.
  agent ??= new Agent({ allowH2: false, keepAliveTimeout: LLM_KEEP_ALIVE_MS });
  const dispatcher = asDispatcher(agent);
  return (input, init) => pinnedFetch(input, { ...init, dispatcher });
}

/** The real provider `fetch` — see the module doc. */
export const llmFetch: FetchLike = createLlmFetch({
  ambient: () => globalThis.fetch,
  native: NODE_FETCH,
  keepAlive: keepAliveFetch,
});
