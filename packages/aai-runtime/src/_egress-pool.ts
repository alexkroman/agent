// Copyright 2026 the AAI authors. MIT license.
/**
 * The one place this package builds an undici connection pool.
 *
 * It was `_http1-agent.ts`, and `allowH2: false` was described as "the whole
 * mechanism" — a literal in one module so neither of its two readers could lose
 * it. That is the right structure for a flag every caller must share and the
 * wrong one for a flag two callers should be able to DISAGREE about, which is
 * what the measurement behind it actually supports. It was taken on a step's
 * outbound fan-out — 16 concurrent 17.66 MB requests to one origin, of which 14
 * completed over HTTP/2 against 16 over HTTP/1.1, because N streams share one
 * connection's flow-control window and a capacity limit then arrives as a stream
 * RESET carrying no HTTP status (`TypeError: fetch failed`, for every request in
 * flight at once). `sdk/step-fetch.ts` carries the numbers.
 *
 * ## What that measurement covers, and what it does not
 *
 * It is a statement about MULTI-MEGABYTE bodies sharing a window. The runtime's
 * own egress pool inherited the flag and serves two shapes at once: a byte
 * window read or write, which is exactly the measured shape, and a platform RPC
 * — a kilobyte of JSON, one per step transition, in bursts `StepGate` bounds at
 * 16 — where the same reasoning says nothing at all, because a request that
 * cannot fill a window cannot exhaust one.
 *
 * So `allowH2` is an OPTION here, defaulting to `false`. The default is the
 * measured answer for the pool the measurement was taken on, and every caller
 * that wants it states it; see `_egress-fetch.ts` for why exactly one of them
 * may be told otherwise at run time and the other may not.
 *
 * Everything else a caller passes is sizing, because the pools are sized for
 * different jobs: a step's outbound call may legitimately move a multi-gigabyte
 * body, so it raises undici's timeouts to a bound that catches a STALL without
 * truncating a slow transfer (`STEP_FETCH_INACTIVITY_MS`), while the runtime's
 * egress leaves the defaults as the backstop its own bounds do not cover. Note
 * both pools have a bound: the step pool set both to `0` — off — until the
 * "DevKit's step budget" half of that argument was retired with the DevKit.
 *
 * @internal
 */

import { asDispatcher } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { Agent } from "undici";

/**
 * The dispatcher type `fetch` accepts.
 *
 * Taken off {@link asDispatcher} rather than imported: `_undici.ts` publishes the
 * bridge but not its return type, and inferring it here keeps that seam's surface
 * exactly as wide as it already is.
 */
type FetchDispatcher = ReturnType<typeof asDispatcher>;

/** A pool and the dispatcher that puts a request on it. */
export type EgressPool = {
  /** Attach to every request that must go over this pool. */
  dispatcher: FetchDispatcher;
  /**
   * Drain and close it. Idempotent.
   *
   * `close`, not `destroy`: a request already in flight is somebody's, and
   * cutting it off would fail work that was about to finish.
   */
  close(): Promise<void>;
};

/** How one of this package's connection pools is built. */
export type EgressPoolOptions = {
  /**
   * Multiplex over HTTP/2 where the origin offers it. Defaults to `false`.
   *
   * The module doc is the argument. Stated by every caller rather than defaulted
   * silently at the call site, so a pool's answer to it is visible where the
   * pool is built.
   */
  allowH2?: boolean | undefined;
  /** Connections the pool may hold open per origin. */
  connections: number;
  /** How long an idle connection is kept. */
  keepAliveTimeout: number;
  /** Requests queued on one connection — 1 everywhere, see {@link createEgressPool}. */
  pipelining: number;
  /**
   * undici's header timeout. Omit for its default (300s).
   *
   * `0` disables it, and no caller here passes that any more: with both timers
   * off, a request making no progress is bounded by nothing at all unless the
   * caller passed a signal — see `STEP_FETCH_INACTIVITY_MS`.
   */
  headersTimeout?: number | undefined;
  /** undici's body-inactivity timeout. Omit for its default; see above on `0`. */
  bodyTimeout?: number | undefined;
};

/**
 * Build one keep-alive pool.
 *
 * `pipelining` is a caller's number only so that the call sites can state it;
 * every one passes 1 today, and anything else is the HTTP/1.1 shape of
 * head-of-line blocking — several requests queued on a single connection, where
 * a slow or reset one holds up the rest. Note it means something ELSE under
 * HTTP/2: undici gates a connection's in-flight STREAMS behind this number, so a
 * pool with `allowH2` and `pipelining: 1` serializes what it meant to multiplex
 * (nodejs/undici#4143). A caller that turns H2 on has to raise it in the same
 * breath, which is why they are two fields of one options object and not two
 * unrelated knobs.
 */
export function createEgressPool(opts: EgressPoolOptions): EgressPool {
  const agent = new Agent({
    // Defaulted rather than fixed — see the module doc.
    allowH2: opts.allowH2 ?? false,
    connections: opts.connections,
    keepAliveTimeout: opts.keepAliveTimeout,
    pipelining: opts.pipelining,
    // Omitted rather than passed as `undefined`, because the two pools differ in
    // exactly this: a step RAISES undici's timeouts (its bodies can be gigabytes,
    // so the bound has to catch a stall rather than a slow transfer) and the
    // runtime's egress leaves them at undici's defaults, which are the only bound
    // its own body reads have. `{ bodyTimeout: undefined }` is not the same
    // request as no key at all.
    ...omitUndefined({ headersTimeout: opts.headersTimeout, bodyTimeout: opts.bodyTimeout }),
  });
  return { dispatcher: asDispatcher(agent), close: () => agent.close() };
}
