// Copyright 2025 the AAI authors. MIT license.
// Event-loop delay monitor: proves whether the Node event loop is blocking
// under load before we reach for more expensive fixes.

import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";

export type EventLoopMonitorOptions = {
  /** Sample interval for the underlying histogram, ms. Default 10. */
  resolutionMs?: number;
  /** Emit a log line every N ms. Default 10_000. */
  logIntervalMs?: number;
  /** Override log sink (defaults to console.info). */
  log?: (msg: string, data: Record<string, unknown>) => void;
};

export type EventLoopMonitorHandle = {
  /** Snapshot current stats without resetting (for tests). */
  snapshot(): { p50: number; p95: number; max: number; count: number };
  /** Stop logging and dispose the histogram. */
  stop(): void;
};

/**
 * Starts a lightweight event-loop delay monitor and logs p50/p95/max every
 * `logIntervalMs` (default 10 s). Under healthy load on a well-scaled VM,
 * p95 should stay well under 50 ms. Sustained p95 > 50 ms means CPU-bound
 * work on the main thread is blocking message dispatch — which shows up
 * externally as "the server silently dropped reply_done".
 *
 * The histogram is reset after each emit so each log line covers one
 * `logIntervalMs` window.
 */
export function startEventLoopMonitor(opts: EventLoopMonitorOptions = {}): EventLoopMonitorHandle {
  const resolutionMs = opts.resolutionMs ?? 10;
  const logIntervalMs = opts.logIntervalMs ?? 10_000;
  const log = opts.log ?? ((msg, data) => console.info(msg, data));

  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const interval = setInterval(() => {
    const snap = snapshotOf(histogram);
    if (snap.count === 0) return;
    log("event-loop delay", snap);
    histogram.reset();
  }, logIntervalMs);
  interval.unref();

  return {
    snapshot: () => snapshotOf(histogram),
    stop(): void {
      clearInterval(interval);
      histogram.disable();
    },
  };
}

function snapshotOf(h: IntervalHistogram): {
  p50: number;
  p95: number;
  max: number;
  count: number;
} {
  // node:perf_hooks reports nanoseconds; convert to ms and round to 2 dp so
  // the log line is readable.
  const toMs = (ns: number): number => Math.round((ns / 1e6) * 100) / 100;
  return {
    p50: toMs(h.percentile(50)),
    p95: toMs(h.percentile(95)),
    max: toMs(h.max),
    count: h.count,
  };
}
