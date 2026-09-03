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
 * ## `allowH2: false` is the entire mechanism, and it lives in `_egress-pool.ts`
 *
 * undici's connector offers `ALPNProtocols: allowH2 ? ['http/1.1', 'h2'] :
 * ['http/1.1']`, and undici 8 defaults `allowH2` to **true** — so turning it off
 * is what stops the far side upgrading a fan-out onto one multiplexed
 * connection. It moved to `_egress-pool.ts` when the runtime's OWN egress needed
 * the same flag for the same reason (`_egress-fetch.ts`, which carries the
 * production failure that found it); everything else here is sizing.
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

import type { StepFetch } from "@alexkroman1/aai/host-internal";
import {
  type PinnedRequestInit,
  pinnedFetch,
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_INACTIVITY_MS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} from "@alexkroman1/aai/host-internal";
import type { StepFetchInit } from "@alexkroman1/aai/step";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createEgressPool } from "./_egress-pool.ts";
import { currentRun } from "./workflow-run-context.ts";

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
  const pool = createEgressPool({
    // Stated rather than defaulted: this is the pool the measurement below was
    // taken on, so it is the one caller for which HTTP/1.1 is a finding.
    allowH2: false,
    connections: STEP_FETCH_CONNECTIONS,
    keepAliveTimeout: STEP_FETCH_KEEP_ALIVE_MS,
    pipelining: STEP_FETCH_PIPELINING,
    // A REQUEST THAT STOPS PROGRESSING is bounded here, and a request's total
    // duration is bounded by the caller's own `AbortSignal`. Both were `0` — off
    // — on the argument that a step owns its own deadline, "an `AbortSignal` it
    // passes, or the DevKit's step budget"; the second clause went with the
    // DevKit and was the only half that covered a step passing no signal. See
    // `STEP_FETCH_INACTIVITY_MS` for why an inactivity bound needs no
    // per-file tuning where a total-duration one would, and for the number.
    //
    // The runtime's own egress pool leaves undici's DEFAULTS instead, which are
    // tighter — see `_egress-fetch.ts`; the difference is now the value rather
    // than whether there is one at all.
    headersTimeout: STEP_FETCH_INACTIVITY_MS,
    bodyTimeout: STEP_FETCH_INACTIVITY_MS,
  });
  const dispatcher = pool.dispatcher;
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
        signal: stepSignal(init.signal),
        // Required by undici (and by the spec) for a streaming request body, and
        // REFUSED alongside a plain one — so it is set only when the body really is
        // an iterable. A step sending a stored upload window by window is the case
        // this exists for.
        duplex: isStreamingBody(init.body) ? "half" : undefined,
      }),
    };
    return pinnedFetch(url, request);
  };
  // `close`, not `destroy` — see `createEgressPool`. A request already in flight
  // when the server shuts down is a step's, and cutting it off would fail a run
  // that was about to finish. Idle keep-alive sockets — the thing a rebuild
  // strands — go either way.
  return { fetch, close: pool.close };
}

/**
 * The caller's signal, COMBINED with the walk's.
 *
 * The engine hands a step body no `AbortSignal` — deliberately, because
 * `stepFetch` is reached from inside a step's own helpers and a parameter would
 * have to be threaded through every one of them (see `RunContext["step"]`). So
 * the walk's signal is read out of the run context here, which is the one place
 * every step's outbound HTTP already goes through.
 *
 * What it buys is that a CANCEL reaches a step's I/O. Without it a cancelled run
 * — or a delivery whose caller hung up — went on uploading a recording nobody
 * was waiting for until the process died, and `attemptLoop`'s abort arm could
 * only unwind once the request it could not see had finished.
 *
 * `AbortSignal.any` rather than replacing either: a caller's own deadline still
 * fires first, and sources are held weakly so there is no unlink bookkeeping.
 * Outside a run — a step called directly from a spec — there is no walk and the
 * caller's signal passes through untouched.
 */
function stepSignal(callerSignal: AbortSignal | undefined): AbortSignal | undefined {
  const walk = currentRun()?.step?.signal;
  if (!walk) return callerSignal;
  return callerSignal ? AbortSignal.any([callerSignal, walk]) : walk;
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
