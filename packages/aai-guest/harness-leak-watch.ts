// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn Node's one-shot listener-leak warning into something that keeps
 * reporting.
 *
 * ## Node warns ONCE, and then the leak is invisible
 *
 * `MaxListenersExceededWarning` is emitted from `_addListener` behind an
 * `existing.warned` flag that is set the first time the count crosses the
 * threshold and never cleared. Measured: attaching **500** listeners to one
 * event emits **exactly one** warning, at 11. Nothing re-reports at 50, at 100,
 * or at 500.
 *
 * That is the whole reason this module exists, and it is what made the
 * `streamTail` leak (#1203) expensive to diagnose. The line was in the log —
 * relayed to the host by `startGuestLogging` and teed into the studio's buffer
 * by `harness-logs.ts` — so a handler that merely logged it AGAIN would add a
 * duplicate of something already in both places. What was missing is the
 * second, third and hundredth line: from the outside a leak at 11 and a leak at
 * 900 look identical, so there is no way to tell a threshold brushed once by a
 * busy call from one climbing all afternoon, which is exactly the judgement a
 * person reading the log has to make.
 *
 * ## So it re-reads the count
 *
 * The warning object carries the `emitter` and the event `type`, so the count
 * can be re-read later — `listenerCount(type)` — and reported when it has
 * meaningfully GROWN. Growth is what distinguishes a leak from a high-water
 * mark; an absolute number cannot.
 *
 * Three properties keep the watcher from becoming the thing it detects:
 *
 * - **The emitter is held by `WeakRef`.** A strong reference to every emitter
 *   that ever tripped the threshold is a leak with this module's name on it,
 *   and it would pin exactly the objects most likely to be large (a leaked
 *   world-stream emitter holds every buffered chunk).
 * - **The timer is `unref`'d.** An agent guest self-exits on idle, and a
 *   diagnostic that keeps the process alive changes what it is measuring.
 * - **It reports on a RATIO, not on every sweep.** A count that is stable, or
 *   creeping by one, produces no output at all; each report raises the bar it
 *   must next clear, so a genuine leak yields a handful of lines over its life
 *   rather than one per minute.
 *
 * `EventTarget` (an `AbortSignal`) has no `listenerCount`, so those are reported
 * once and not tracked — the first line is still strictly more than the nothing
 * Node gives an EventTarget by default. Opting one in is the caller's job; see
 * `SESSION_SIGNAL_MAX_LISTENERS` in `aai/host/transports/pipeline-transport.ts`.
 *
 * @module
 */

import { isRecord } from "@alexkroman1/aai/utils";

/** How often to re-read the counts of emitters that have already warned. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Growth factor a tracked count must reach before it is reported again.
 *
 * Multiplicative rather than additive so the report rate falls as the leak
 * grows: a pair-per-second leak reports at ~22, ~44, ~88 … which is a dozen
 * lines over an hour, where "+10" would be one line every ten seconds and would
 * itself become log noise nobody reads.
 */
const REPORT_GROWTH_FACTOR = 2;

/** One emitter/event pair that has crossed its threshold at least once. */
type Tracked = {
  readonly ref: WeakRef<{ listenerCount(type: string | symbol): number }>;
  readonly type: string;
  /** The count at the last line printed about this pair. */
  reported: number;
};

/** What a `MaxListenersExceededWarning` carries beyond a plain `Error`. */
type MaxListenersWarning = Error & {
  emitter?: unknown;
  type?: string | symbol;
  count?: number;
};

/**
 * Whether a value can answer `listenerCount` — i.e. is an EventEmitter rather
 * than an EventTarget. `isRecord` rather than an open-coded
 * `typeof v === "object" && v !== null` (guard-invariants rule 17), which also
 * buys the narrowing that makes the property read legal.
 */
function isCountable(value: unknown): value is { listenerCount(type: string | symbol): number } {
  return isRecord(value) && typeof value.listenerCount === "function";
}

/**
 * Install the watcher.
 *
 * Returns a stop function for tests; the guest never calls it — the watcher
 * lives as long as the process does, which is the point.
 */
export function installLeakWatch(
  log: (message: string) => void = (message) => console.error(message),
): () => void {
  const tracked: Tracked[] = [];

  const onWarning = (warning: Error): void => {
    if (warning.name !== "MaxListenersExceededWarning") return;
    const { emitter, type, count } = warning as MaxListenersWarning;
    const event = typeof type === "symbol" ? type.toString() : (type ?? "unknown");
    const at = typeof count === "number" ? count : Number.NaN;
    // Deliberately a DIFFERENT shape from Node's own prose line, which is
    // already in this log: this one is greppable by a fixed prefix and names
    // the event, which is what identifies the leaking subsystem (a world
    // stream's event name carries the run id).
    log(`Guest: listener leak suspected on "${event}" — ${at} listeners`);
    if (isCountable(emitter) && typeof type === "string") {
      tracked.push({ ref: new WeakRef(emitter), type, reported: at });
    }
  };

  process.on("warning", onWarning);

  const sweep = (): void => {
    // Iterated backwards so a collected emitter can be spliced out in place.
    for (let i = tracked.length - 1; i >= 0; i -= 1) {
      const entry = tracked[i];
      if (entry === undefined) continue;
      const emitter = entry.ref.deref();
      if (emitter === undefined) {
        // The emitter was collected, which means it was never a leak — or the
        // leak ended with whatever held it. Either way there is nothing to say.
        tracked.splice(i, 1);
        continue;
      }
      const now = emitter.listenerCount(entry.type);
      if (now < entry.reported * REPORT_GROWTH_FACTOR) continue;
      log(
        `Guest: listener leak GROWING on "${entry.type}" — ${now} listeners ` +
          `(was ${entry.reported})`,
      );
      entry.reported = now;
    }
  };

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();

  return (): void => {
    process.off("warning", onWarning);
    clearInterval(timer);
  };
}
