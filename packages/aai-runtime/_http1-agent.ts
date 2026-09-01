// Copyright 2026 the AAI authors. MIT license.
/**
 * The one place this package builds an undici pool that speaks HTTP/1.1.
 *
 * `allowH2: false` is the whole mechanism, and it now has TWO readers — a step's
 * outbound call (`step-fetch.ts`) and the runtime's own egress to the platform
 * and the bucket (`_egress-fetch.ts`) — so the flag, and the argument for it,
 * live here rather than as a literal each of them could lose independently.
 * `sdk/step-fetch.ts` carries the measurements; the short version is that undici
 * 8 defaults `allowH2` to **true**, so N concurrent requests to one origin are
 * multiplexed onto ONE TCP connection sharing one flow-control window, and a
 * capacity limit then arrives as a STREAM RESET carrying no HTTP status —
 * `TypeError: fetch failed`, for every request in flight at once.
 *
 * Everything else a caller passes is sizing, because the two pools are sized for
 * different jobs: a step owns its own deadline and turns undici's timeouts off,
 * while the runtime's egress wants them as the backstop its own bounds do not
 * cover.
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
export type Http1Pool = {
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

/** How one of this package's HTTP/1.1 pools is sized. */
export type Http1PoolOptions = {
  /** Connections the pool may hold open per origin. */
  connections: number;
  /** How long an idle connection is kept. */
  keepAliveTimeout: number;
  /** Requests queued on one connection — 1 everywhere, see {@link createHttp1Pool}. */
  pipelining: number;
  /** undici's header timeout; `0` disables it. */
  headersTimeout?: number | undefined;
  /** undici's body-inactivity timeout; `0` disables it. */
  bodyTimeout?: number | undefined;
};

/**
 * Build one HTTP/1.1 keep-alive pool.
 *
 * `pipelining` is a caller's number only so that the two call sites can state it;
 * both pass 1, and anything else is the HTTP/1.1 shape of the head-of-line
 * blocking this module exists to remove — several requests queued on a single
 * connection, where a slow or reset one holds up the rest.
 */
export function createHttp1Pool(opts: Http1PoolOptions): Http1Pool {
  const agent = new Agent({
    // The point of the whole module — see above.
    allowH2: false,
    connections: opts.connections,
    keepAliveTimeout: opts.keepAliveTimeout,
    pipelining: opts.pipelining,
    // Omitted rather than passed as `undefined`, because the two pools differ in
    // exactly this: a step turns undici's timeouts OFF (it owns its own deadline)
    // and the runtime's egress leaves them at undici's defaults, which are the only
    // bound its own body reads have. `{ bodyTimeout: undefined }` is not the same
    // request as no key at all.
    ...omitUndefined({ headersTimeout: opts.headersTimeout, bodyTimeout: opts.bodyTimeout }),
  });
  return { dispatcher: asDispatcher(agent), close: () => agent.close() };
}
