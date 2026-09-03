// Copyright 2026 the AAI authors. MIT license.
/**
 * The `fetch` this runtime makes every call of its OWN with — the platform's
 * routes, and the bucket a window is read from.
 *
 * ## `globalThis.fetch` was the wrong one, and the repo already knew
 *
 * `sdk/step-fetch.ts` measured it and fixed it for a STEP's outbound call: undici
 * 8 — the copy backing `globalThis.fetch` from Node 26 — defaults `allowH2` to
 * `true`, so a fan-out gets multiplexed onto ONE TCP connection sharing one
 * flow-control window, and a capacity limit arrives as a stream reset that
 * carries no HTTP status. 14 of 16 concurrent 17.66 MB requests landed on
 * `globalThis.fetch` against 16/16 on HTTP/1.1. That table is the whole argument
 * and is not restated here.
 *
 * What was left behind is that the RUNTIME's own calls are the same shape and
 * were still on the global: the upload broker's byte operations
 * (`_upload-blobs-brokered.ts`), the operator-bucket ones beside them
 * (`_upload-blobs-http.ts`), and every platform RPC (`platform-rpc.ts`). All of
 * them go to ONE origin, several at a time, some carrying megabytes.
 *
 * **Observed in production**, on a deployed transcription workflow uploading a
 * ~64 MB file in 8 MB windows:
 *
 * ```text
 * Workflow run event read failed { runId: 'wrun_…', error: 'fetch failed', failures: 2 }
 * Workflow API request failed { error: 'fetch failed' }
 * PUT …/workflows/uploads/<id>/parts -> 500 Internal Server Error (execution: 37.9 s)
 * ```
 *
 * Three things in that log are the h2 signature rather than three separate bugs.
 * The failures are simultaneous across UNRELATED routes — a claim's bucket probes
 * and the run-event stream's storage reads — because those requests shared one
 * connection. The error is `fetch failed` with no status, which is what a stream
 * reset looks like from `fetch`. And the claim's own retry
 * (`BYTE_OP_ATTEMPTS`, ~750 ms of budget) could not help, because re-issuing in
 * lockstep onto the connection that just reset is the failure, not the cure.
 *
 * ## One pool for the process, not one per server
 *
 * Unlike the step pool, which is per `AgentServer` because `aai dev` builds a new
 * one on every file save, this is addressed by the process's OWN environment
 * (`AAI_PLATFORM_BASE_URL`, `AAI_GUEST_TOKEN`) and serves callers with no server
 * to hang a lifetime off — `platformPost` is reached from four clients that each
 * hold nothing but a base and a bearer. So it is a lazy singleton, and
 * {@link closeEgressFetch} resets it rather than poisoning it: a caller holding
 * {@link egressFetch} across a close gets a fresh pool on its next request
 * instead of a closed one.
 *
 * ## Bodies must be plain
 *
 * This goes through `pinnedFetch`, so the rule in `host/_undici.ts` applies: a
 * `FormData`, `Blob`, `Headers` or `Request` built from the GLOBAL undici
 * brand-checks against the wrong classes and is silently stringified. Every
 * caller here passes a `Uint8Array` or a string body and a plain header record,
 * which is what makes the swap safe.
 */

import { type PinnedRequestInit, pinnedFetch } from "@alexkroman1/aai/host-internal";
import { createHttp1Pool, type Http1Pool } from "./_http1-agent.ts";

/**
 * Connections the egress pool may hold open per origin.
 *
 * Has to clear the widest burst the runtime issues at one origin, which is a
 * part claim's bucket probes — `UPLOAD_PROBE_CONCURRENCY`, 32 — with a step's
 * window reads, the platform posts and the run-event poll on top. 64 matches the
 * step pool's cap and is for the same reason: above anything worth attempting,
 * so it bounds rather than shapes.
 */
const EGRESS_CONNECTIONS = 64;

/**
 * How long an idle egress connection is kept.
 *
 * The bursts arrive seconds apart — a claim, then the next batch of windows — and
 * a fresh TLS handshake per request was worth ~20% of wall time in the
 * measurements `sdk/step-fetch.ts` records.
 *
 * **EXPORTED because a client keep-alive is only half of one**, and the other
 * half is the SERVER's: whichever side reaps first decides, so a client value
 * above the server's is unreachable. `aai-server` derives its own
 * `HTTP_KEEP_ALIVE_TIMEOUT_MS` from this rather than restating a number, which
 * is the drift that made this one dead config for the journal — see that
 * constant. The upload measurement above is what SET the number; it is not what
 * makes it effective.
 *
 * @internal
 */
export const EGRESS_KEEP_ALIVE_MS = 30_000;

/**
 * The pool, built on first use.
 *
 * Lazy because a process that never reaches the platform (a unit test, a local
 * `aai dev` with no broker) must not open one, and because every caller passes
 * its own `fetch` in tests — so in the suite this stays `undefined`.
 */
let pool: Http1Pool | undefined;

function current(): Http1Pool {
  pool ??= createHttp1Pool({
    connections: EGRESS_CONNECTIONS,
    keepAliveTimeout: EGRESS_KEEP_ALIVE_MS,
    // See `createHttp1Pool` — the head-of-line blocking this pool exists to avoid
    // has an HTTP/1.1 spelling too.
    pipelining: 1,
    // LEFT AT undici's defaults (300s each), which are TIGHTER than the step
    // pool's raised bound rather than merely different: the callers here bound the
    // REQUEST (`BYTE_OP_TIMEOUT_MS`, `PlatformCall.timeoutMs`) and nothing bounds
    // draining the body afterwards — which is exactly what a window `read` does —
    // so undici's body-inactivity timeout is the only limit that path has. A step
    // needs a longer one because its bodies can be gigabytes; see
    // `STEP_FETCH_INACTIVITY_MS`.
  });
  return pool;
}

/**
 * The runtime's own outbound `fetch`.
 *
 * A stable function rather than the pool's own, so a reference stored by a
 * long-lived client keeps working across a {@link closeEgressFetch}.
 *
 * Typed as the global's signature because that is the slot every caller declares,
 * but a `Request` first argument is NOT supported — see the module doc on bodies.
 */
export const egressFetch: typeof globalThis.fetch = (input, init) => {
  // The cast is on the WHOLE init, not on the dispatcher, and it is the
  // `BodyInit` mismatch `packages/aai-runtime/CLAUDE.md` records: a caller's
  // `RequestInit` is whichever ambient copy won in ITS program — the DOM's in
  // `aai-templates`, whose `BodyInit` is not undici's — so spreading one into
  // `pinnedFetch`'s parameter is `TS2769` in exactly the consumer that has
  // `lib.dom`. Sound because the shapes really are structurally the same at
  // runtime, and because the one class of value that is NOT (a `FormData`,
  // `Blob`, `Headers` or `Request` from the global realm) is ruled out by this
  // module's contract rather than by the type.
  const request = { ...init, dispatcher: current().dispatcher } as PinnedRequestInit;
  return pinnedFetch(input, request);
};

/**
 * Drain and close the pool, if one was built.
 *
 * Called from the server's own close so a rebuilt `aai dev` server does not
 * strand keep-alive sockets. The singleton is cleared first, so a request that
 * arrives after this builds a new pool rather than failing on a closed one.
 */
export async function closeEgressFetch(): Promise<void> {
  const held = pool;
  pool = undefined;
  await held?.close();
}
