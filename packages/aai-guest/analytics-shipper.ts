// Copyright 2026 the AAI authors. MIT license.
/**
 * Ships the runtime's session analytics from a deployed agent's guest to the
 * platform's `POST /analytics/ingest`.
 *
 * The runtime records events synchronously into an in-memory buffer (see
 * `aai/host/analytics.ts`); this drains that buffer over HTTP on a timer. It
 * is the only outbound platform call an agent-mode guest makes at all — a
 * deployed guest holds no control channel — so everything about it is shaped
 * by "must not affect the call in progress".
 *
 * ## At-most-once, deliberately
 *
 * A failed shipment is DROPPED, not retried. The alternative was considered
 * and is worse in exactly the environment this runs in: a guest is memory-
 * capped (see the burst-range note in `packages/aai-server/CLAUDE.md`), and a
 * platform outage is precisely when every guest would be accumulating a
 * retry queue at once — turning a monitoring degradation into agents dying
 * mid-call. Analytics are a sample of what happened, not a ledger; the
 * consumer is a percentile and a trend, both of which survive gaps. What must
 * never happen is a voice session paying for the loss.
 *
 * The buffer is capped for the same reason, and drops the OLDEST rows when it
 * overflows: the newest events are the ones a user is looking at the pane for.
 *
 * ## Three flush triggers, and the last one is the one that gets forgotten
 *
 * A timer (steady state), a full batch (a busy agent), and **shutdown** —
 * `POST /manage/drain` and the guest's own idle self-exit. Without that last
 * one the final rows of every session are lost, and they are the rows that say
 * how the session ENDED, which is the question the pane exists to answer.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { AnalyticsEvent, AnalyticsSink } from "@alexkroman1/aai/runtime";
import { omitUndefined } from "@alexkroman1/aai/utils";

export type AnalyticsShipperOptions = {
  /** Absolute ingest URL, e.g. `https://platform/analytics/ingest`. */
  url: string;
  /** The per-slug ingest token the spawner minted (aai-server/analytics-token.ts). */
  token: string;
  slug: string;
  /** Deploy generation, so rows can be cut by version. */
  agentVersion?: number | undefined;
  /** Steady-state flush period. */
  flushIntervalMs?: number;
  /** Rows per shipment; also the "flush now" threshold. */
  maxBatch?: number;
  /** Buffer ceiling before the oldest rows are dropped. */
  maxBuffer?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof globalThis.fetch;
};

export type AnalyticsShipper = {
  sink: AnalyticsSink;
  /** Send whatever is buffered now. Never rejects. */
  flush(): Promise<void>;
  /** Stop the timer and flush one last time. Idempotent. */
  stop(): Promise<void>;
  /** Rows dropped by overflow or by a failed shipment — for the guest's log. */
  readonly dropped: number;
};

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
/** Must stay at or below the ingest route's `MAX_BATCH_ROWS`. */
const DEFAULT_MAX_BATCH = 200;
const DEFAULT_MAX_BUFFER = 2000;
/** A shipment that hangs must not pin the buffer or delay a drain. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One event in the ingest route's wire shape. Optional fields are omitted
 * rather than sent as null: the route's schema treats absent as "not
 * reported", and `exactOptionalPropertyTypes` makes that the only spelling
 * that compiles anyway.
 *
 * `text` on the wire, `body` in the column — the row's own name for it
 * collides with the HTTP body everywhere else in this module.
 */
function toWireEvent(event: AnalyticsEvent): Record<string, unknown> {
  return {
    sessionId: event.sessionId,
    ts: event.ts,
    kind: event.kind,
    turn: event.turn,
    ...omitUndefined({
      durationMs: event.durationMs === undefined ? undefined : Math.round(event.durationMs),
      level: event.level,
      name: event.name,
      text: event.text,
      ok: event.ok,
      data: event.data,
    }),
  };
}

export function createAnalyticsShipper(opts: AnalyticsShipperOptions): AnalyticsShipper {
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  let buffer: AnalyticsEvent[] = [];
  let dropped = 0;
  let stopped = false;
  /** Latched by a 404: the platform says the feature is off. Stop for good. */
  let disabled = false;
  /**
   * Shipments are SERIALIZED BY CHAINING, not coalesced onto whichever one is
   * already running. Returning the in-flight promise looks equivalent and is
   * not: that shipment took its batch out of the buffer before the caller's
   * rows arrived, so the caller waits for a request that carries none of what
   * it asked to send — and `stop()`, which loops until the buffer drains,
   * sees no progress and gives up. A queued no-op flush costs one settled
   * promise, which is the cheaper mistake by far.
   */
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function ship(batch: AnalyticsEvent[]): Promise<void> {
    const body = JSON.stringify({
      slug: opts.slug,
      ...omitUndefined({ agentVersion: opts.agentVersion }),
      events: batch.map(toWireEvent),
    });

    const res = await doFetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The platform has no analytics binding. Retrying costs a request per
      // flush for the life of the sandbox and can never succeed.
      disabled = true;
      buffer = [];
      return;
    }
    if (!res.ok) throw new Error(`ingest answered HTTP ${res.status}`);
  }

  function flushOnce(): Promise<void> {
    if (disabled || buffer.length === 0) return Promise.resolve();
    // Taken out of the buffer BEFORE the await: rows recorded during the
    // shipment belong to the next batch, and leaving them in would ship them
    // twice on a slow link. `splice` rather than two `slice`s — it returns the
    // batch and leaves the remainder in place, where the pair copied the tail
    // a second time on every flush.
    const batch = buffer.splice(0, maxBatch);
    return ship(batch).catch((err: unknown) => {
      dropped += batch.length;
      console.warn(`[analytics] dropped ${batch.length} events: ${errorMessage(err)}`);
    });
  }

  function flush(): Promise<void> {
    // `flushOnce` never rejects (it catches and counts a drop), so the chain
    // can never be wedged by a failed shipment.
    chain = chain.then(() => flushOnce());
    return chain;
  }

  const start = (): void => {
    if (timer || stopped) return;
    timer = setInterval(() => void flush(), flushIntervalMs);
    // Never hold the event loop open on analytics: the guest's idle self-exit
    // decides when this process ends, and a live interval would outvote it.
    timer.unref?.();
  };
  start();

  return {
    sink: {
      record(event) {
        if (stopped || disabled) return;
        buffer.push(event);
        if (buffer.length > maxBuffer) {
          // Oldest first: a pane shows the recent past, and a buffer this deep
          // means shipping is already failing. In place — the overflow is
          // almost always one event, and reallocating a 2,000-element array
          // per event is not what a degraded sandbox should be spending memory
          // bandwidth on.
          dropped += buffer.splice(0, buffer.length - maxBuffer).length;
        }
        if (buffer.length >= maxBatch) void flush();
      },
    },
    flush,
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Drain rather than flush once: a session that just ended may have left
      // more than one batch behind, and this is the last chance any of it has.
      while (buffer.length > 0 && !disabled) {
        const before = buffer.length;
        await flush();
        if (buffer.length >= before) break; // no progress — stop rather than spin
      }
    },
    get dropped() {
      return dropped;
    },
  };
}

/**
 * Build a shipper from the guest's boot env, or `undefined` when the spawner
 * did not configure one (self-hosted runs, local dev, a platform with the
 * feature off). Absent means the runtime is handed no sink and records
 * nothing at all — analytics costs zero when it is not switched on.
 */
export function analyticsShipperFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnalyticsShipper | undefined {
  const url = env.AAI_ANALYTICS_URL;
  const token = env.AAI_ANALYTICS_TOKEN;
  const slug = env.AAI_ANALYTICS_SLUG;
  if (!(url && token && slug)) return;
  const version = Number(env.AAI_ANALYTICS_VERSION);
  return createAnalyticsShipper({
    url,
    token,
    slug,
    ...(Number.isFinite(version) ? { agentVersion: version } : {}),
  });
}
