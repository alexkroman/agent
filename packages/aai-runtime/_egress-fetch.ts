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
 * ## TWO pools, because the traffic is two shapes
 *
 * It was one, and the shapes it serves have nothing in common but a hostname:
 *
 * | | {@link rpcFetch} | {@link blobFetch} |
 * | --- | --- | --- |
 * | Body | ~1 kB of JSON | up to `UPLOAD_PART_BYTES` |
 * | Rate | one per step transition | one per window |
 * | Widest burst | `StepGate`, 16 | `UPLOAD_PROBE_CONCURRENCY`, 32 |
 * | Reached from | `platform-rpc.ts` | the two `_upload-blobs-*` |
 *
 * Sharing one pool between them is not merely untidy. A pool is a fixed number
 * of connections, so a claim's 32 concurrent probes and a step's window reads
 * are competing for the sockets a journal write then queues behind — and, worse,
 * one `allowH2` decision was serving both when the measurement behind it is
 * about multi-megabyte bodies exhausting a flow-control window. A kilobyte of
 * JSON cannot exhaust one. That the RPC path was H1 was therefore not a
 * conclusion; it was inheritance.
 *
 * Both default to HTTP/1.1 — nothing has measured the RPC path either way, and
 * an unmeasured change to the transport under every durable run is not a change
 * to make on a plausible argument. What is different is that the RPC pool's
 * answer is now a DECISION, and one an operator can revisit without a deploy:
 * {@link EGRESS_RPC_HTTP2_ENV} turns H2 on for that pool alone. The byte pool
 * takes no such switch, and the asymmetry is the point — H2 there is the
 * configuration that was measured FAILING, so a switch would only offer an
 * operator the known-bad answer.
 *
 * ## Both are per PROCESS, not per server
 *
 * Unlike the step pool, which is per `AgentServer` because `aai dev` builds a new
 * one on every file save, these are addressed by the process's OWN environment
 * (`AAI_PLATFORM_BASE_URL`, `AAI_GUEST_TOKEN`) and serve callers with no server
 * to hang a lifetime off — `platformPost` is reached from four clients that each
 * hold nothing but a base and a bearer. So they are lazy singletons, and
 * {@link closeEgressFetch} resets them rather than poisoning them: a caller
 * holding {@link rpcFetch} across a close gets a fresh pool on its next request
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
import { createEgressPool, type EgressPool } from "./_egress-pool.ts";
import { isDebugEnv } from "./runtime-config.ts";

/**
 * Connections one egress pool may hold open per origin.
 *
 * Has to clear the widest burst the runtime issues at one origin, which for the
 * byte pool is a part claim's bucket probes — `UPLOAD_PROBE_CONCURRENCY`, 32 —
 * with a step's window reads on top, and for the RPC pool is `StepGate`'s 16
 * plus the run-level reads. 64 matches the step pool's cap and is for the same
 * reason: above anything worth attempting, so it bounds rather than shapes.
 *
 * ONE number for both pools, deliberately. Splitting the pools does not license
 * re-sizing them: 64 was never a measured fit for either shape, it was a ceiling,
 * and two unmeasured numbers are worse than one. What the split buys at this
 * sizing is ISOLATION — the byte path can no longer occupy the sockets an RPC
 * queues behind — and that is the whole of the claim being made for it.
 */
const EGRESS_CONNECTIONS = 64;

/**
 * The variable that lets an operator try HTTP/2 on the RPC pool.
 *
 * `1` or `true`, read once at pool construction. Named as a constant so the
 * spelling has one home and the test asserts the same string an operator sets.
 *
 * There is deliberately no companion for the byte pool — see the module doc.
 *
 * @internal
 */
export const EGRESS_RPC_HTTP2_ENV = "AAI_EGRESS_RPC_HTTP2";

/**
 * In-flight HTTP/2 streams per connection, when the switch above is on.
 *
 * undici gates them behind `pipelining` (nodejs/undici#4143), so leaving that at
 * the HTTP/1.1 answer of 1 would turn the switch into a pessimization: one
 * connection, one request at a time, where HTTP/1.1 had `EGRESS_CONNECTIONS` of
 * them in parallel. It has to clear the widest burst the RPC path issues, which
 * is `StepGate`'s 16 plus the run-level reads; 64 matches the connection cap and
 * is a ceiling for the same reason.
 */
const EGRESS_RPC_H2_STREAMS = 64;

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
 * Each pool, built on first use.
 *
 * Lazy because a process that never reaches the platform (a unit test, a local
 * `aai dev` with no broker) must not open one, and because every caller passes
 * its own `fetch` in tests — so in the suite these stay `undefined`. A process
 * that only ever RPCs never builds the byte pool, and the reverse.
 */
let rpcPool: EgressPool | undefined;
let blobPool: EgressPool | undefined;

/**
 * Whether the RPC pool may multiplex, read from the process environment.
 *
 * Takes an `env` so a spec can state one — the repo's idiom for this
 * (`resolveCodeVersion`, `localWorkflowDataDir`) — and reads the same
 * `isDebugEnv` grammar (`1` / `true`) every other flag in this package uses,
 * rather than inventing a third spelling of a boolean.
 *
 * @internal
 */
export function egressRpcAllowsH2(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDebugEnv(env[EGRESS_RPC_HTTP2_ENV]);
}

function rpc(): EgressPool {
  rpcPool ??= createEgressPool({
    connections: EGRESS_CONNECTIONS,
    keepAliveTimeout: EGRESS_KEEP_ALIVE_MS,
    // The two travel TOGETHER, and `createEgressPool` says why: under HTTP/2
    // undici gates a connection's in-flight streams behind `pipelining`, so
    // `allowH2` with `pipelining: 1` serializes exactly what it meant to
    // multiplex — the pool would be strictly worse than the HTTP/1.1 it replaced
    // and would look like an H2 problem. Under HTTP/1.1 the same number means
    // requests QUEUED on one connection, where a slow or reset one holds up the
    // rest, so 1 is the right answer there.
    ...(egressRpcAllowsH2()
      ? { allowH2: true, pipelining: EGRESS_RPC_H2_STREAMS }
      : { allowH2: false, pipelining: 1 }),
    // LEFT AT undici's defaults (300s each), which are TIGHTER than the step
    // pool's raised bound rather than merely different: the callers here bound the
    // REQUEST (`PlatformCall.timeoutMs`) and nothing bounds draining the body
    // afterwards, so undici's body-inactivity timeout is the only limit that path
    // has. A step needs a longer one because its bodies can be gigabytes; see
    // `STEP_FETCH_INACTIVITY_MS`.
  });
  return rpcPool;
}

function blob(): EgressPool {
  blobPool ??= createEgressPool({
    connections: EGRESS_CONNECTIONS,
    keepAliveTimeout: EGRESS_KEEP_ALIVE_MS,
    // NOT an option here, and not an oversight: this is the pool whose shape was
    // measured, and HTTP/2 is the answer it measured as losing 2 of 16 requests.
    allowH2: false,
    pipelining: 1,
    // Same reasoning as the RPC pool above — `BYTE_OP_TIMEOUT_MS` bounds the
    // request and undici's default bounds the drain, which is what a window
    // `read` spends its time doing.
  });
  return blobPool;
}

/** Put a request on `pool`, with this module's body contract. */
function through(pool: EgressPool): typeof globalThis.fetch {
  return (input, init) => {
    // The cast is on the WHOLE init, not on the dispatcher, and it is the
    // `BodyInit` mismatch `packages/aai-runtime/CLAUDE.md` records: a caller's
    // `RequestInit` is whichever ambient copy won in ITS program — the DOM's in
    // `aai-templates`, whose `BodyInit` is not undici's — so spreading one into
    // `pinnedFetch`'s parameter is `TS2769` in exactly the consumer that has
    // `lib.dom`. Sound because the shapes really are structurally the same at
    // runtime, and because the one class of value that is NOT (a `FormData`,
    // `Blob`, `Headers` or `Request` from the global realm) is ruled out by this
    // module's contract rather than by the type.
    const request = { ...init, dispatcher: pool.dispatcher } as PinnedRequestInit;
    return pinnedFetch(input, request);
  };
}

/**
 * The runtime's outbound `fetch` for a PLATFORM RPC — small JSON, one per step
 * transition.
 *
 * A stable function rather than the pool's own, so a reference stored by a
 * long-lived client keeps working across a {@link closeEgressFetch}.
 *
 * Typed as the global's signature because that is the slot every caller declares,
 * but a `Request` first argument is NOT supported — see the module doc on bodies.
 */
export const rpcFetch: typeof globalThis.fetch = (input, init) => through(rpc())(input, init);

/**
 * The runtime's outbound `fetch` for BYTES — one upload window per request.
 *
 * Same contract as {@link rpcFetch}; a different pool, for the reasons in the
 * module doc.
 */
export const blobFetch: typeof globalThis.fetch = (input, init) => through(blob())(input, init);

/**
 * Drain and close whichever pools were built.
 *
 * Called from the server's own close so a rebuilt `aai dev` server does not
 * strand keep-alive sockets. The singletons are cleared first, so a request that
 * arrives after this builds a new pool rather than failing on a closed one.
 *
 * `allSettled` rather than `all`: one pool failing to drain must not strand the
 * other, and neither failure is actionable at this point in a shutdown.
 */
export async function closeEgressFetch(): Promise<void> {
  const held = [rpcPool, blobPool];
  rpcPool = undefined;
  blobPool = undefined;
  await Promise.allSettled(held.map((pool) => pool?.close()));
}
