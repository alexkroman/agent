// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of {@link stepFetch}: an HTTP/1.1 `fetch` over a
 * keep-alive pool.
 *
 * `sdk/step-fetch.ts` is the surface a step calls and carries the whole argument
 * for why it exists, with the measurements — read that first. It may not import
 * `undici`, being on the CLI's zero-dependency startup path and riding the
 * browser bundle, so the dispatcher lives here and `createServer` publishes it.
 *
 * ## `allowH2: false` is the entire mechanism
 *
 * undici's connector offers `ALPNProtocols: allowH2 ? ['http/1.1', 'h2'] :
 * ['http/1.1']`, and undici 8 defaults `allowH2` to **true** — so turning it off
 * is what stops the far side upgrading a fan-out onto one multiplexed
 * connection. Everything else here is sizing.
 *
 * It was measured rather than inferred, against the same live endpoint and the
 * same 8-concurrent 17.66 MB segments as the SDK-side table: `allowH2: false`
 * lands 24/24 at p50 3634ms and ~34 MB/s, matching `node:https` (16/16, 3719ms,
 * 29.9 MB/s) and beating `globalThis.fetch` (14/16, 8094ms, 20.8 MB/s). undici
 * was preferred over `node:https` for keeping redirect following, content
 * decoding and `http:`/`https:` in one call.
 *
 * The `_undici.ts` seam is why there is no cast here — that module holds the
 * bridge, and the rule that the dispatcher and the `fetch` must come from the
 * same undici.
 */

import { Agent } from "undici";
import {
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { StepFetch, StepFetchInit } from "../sdk/step-fetch.ts";
import { asDispatcher, type PinnedRequestInit, pinnedFetch } from "./_undici.ts";

/**
 * A published step `fetch`, with the pool behind it.
 *
 * The `close` half is not optional bookkeeping: the pool is per SERVER, and
 * `aai dev` builds a new server on every file save. Without a way to release
 * the previous one, each rebuild stranded a keep-alive pool whose sockets
 * nothing would ever close.
 *
 * Not exported from `/runtime`: every caller takes it by inference, and the
 * pool is this module's business.
 *
 * @internal
 */
type StepFetchHandle = {
  /** What {@link publishStepFetch} publishes. */
  fetch: StepFetch;
  /** Drain and close this handle's connection pool. Idempotent. */
  close(): Promise<void>;
};

/**
 * Build the fetch `createServer` publishes for this process's steps.
 *
 * One dispatcher per call and one call per server, so a fan-out's segments share
 * a warm pool — a TLS handshake per request cost ~20% of wall time in the
 * measurements the SDK-side module records. The pool is returned alongside the
 * fetch rather than captured and forgotten; see {@link StepFetchHandle}.
 *
 * @internal
 */
export function createStepFetch(): StepFetchHandle {
  const agent = new Agent({
    // The point of the whole module — see above.
    allowH2: false,
    connections: STEP_FETCH_CONNECTIONS,
    keepAliveTimeout: STEP_FETCH_KEEP_ALIVE_MS,
    pipelining: STEP_FETCH_PIPELINING,
    // A step owns its own deadline — an `AbortSignal` it passes, or the
    // DevKit's step budget. undici's default 300s header timeout and 300s body
    // timeout would otherwise cut a long provider call off with a transport
    // error the caller cannot classify, which is the failure mode this whole
    // module exists to remove.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const dispatcher = asDispatcher(agent);
  const fetch: StepFetch = (url: string, init: StepFetchInit = {}): Promise<Response> => {
    // Rebuilt rather than spread wholesale: `StepFetchInit` admits only the
    // plain shapes that survive the realm boundary (see `_undici.ts`), and
    // copying it field by field is what keeps a `Headers` or a `FormData` from
    // riding in on a widened caller type.
    const request: PinnedRequestInit = {
      dispatcher,
      ...omitUndefined({
        method: init.method,
        // COPIED, so a caller's object cannot be mutated under it and a
        // `Headers` widened in by a looser caller type cannot ride through.
        headers: init.headers && { ...init.headers },
        body: init.body,
        signal: init.signal,
        // Required by undici (and by the spec) for a streaming request body, and
        // REFUSED alongside a plain one — so it is set only when the body really is
        // an iterable. A step sending a stored upload window by window is the case
        // this exists for.
        duplex: isStreamingBody(init.body) ? "half" : undefined,
      }),
    };
    return pinnedFetch(url, request);
  };
  // `close`, not `destroy`: a request already in flight when the server shuts
  // down is a step's, and cutting it off would fail a run that was about to
  // finish. Idle keep-alive sockets — the thing a rebuild strands — go either way.
  return { fetch, close: () => agent.close() };
}

/**
 * Whether this body is consumed as a stream.
 *
 * A `Uint8Array` is iterable too — over its BYTES — so the check cannot just be
 * "has `Symbol.asyncIterator`" applied loosely; it has to exclude the two plain
 * shapes explicitly, or every ordinary request would be sent as a stream.
 */
function isStreamingBody(body: StepFetchInit["body"]): boolean {
  if (body === undefined || typeof body === "string" || body instanceof Uint8Array) return false;
  return true;
}
