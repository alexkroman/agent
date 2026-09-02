// Copyright 2026 the AAI authors. MIT license.
/**
 * Press to transcript, which is the one number neither bar can give.
 *
 * The upload bar and the progress log describe the two stretches separately, and
 * neither answers the question a reader comparing the three modes is actually
 * asking. Nothing on the server can answer it either — `output.elapsedMs` is the
 * RUN's own wall clock, so in the two modes that store the file first it begins
 * after the upload and misses most of the wait. Only the browser holds both
 * ends.
 *
 * Its own module because it is a self-contained instrument — a stopwatch and the
 * one section that prints it — and `client.tsx` is the file a reader goes to for
 * the page's SHAPE.
 */

import { formatDuration } from "@alexkroman1/aai/utils";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How often the running stopwatch re-renders.
 *
 * Under a second, so the displayed seconds turn over promptly rather than up to a
 * second late; nothing reads this value, since the elapsed time is measured from
 * the clock at render (see {@link useTotalLatency}).
 */
const STOPWATCH_TICK_MS = 250;

/** What {@link useTotalLatency} reports. */
export type TotalLatency = {
  /**
   * Milliseconds since the submit — ticking while the submission is in flight,
   * frozen at the finish, and undefined before the first one.
   */
  elapsedMs: number | undefined;
  /** Whether the clock is still running, which is what makes the label honest. */
  running: boolean;
  /** Start (or restart) the clock. Called from the form's own submit handler. */
  start: () => void;
  /** Drop it, for a panel that no longer describes the submission it timed. */
  clear: () => void;
};

/**
 * Wall clock from the submit to the finish, across both waits.
 *
 * `inFlight` is the submission's own `pending` — true from `submit()` until the run
 * reaches a terminal status — so the clock covers the upload, the run, and the
 * gap between them, which is the whole of what a reader waits for and is the one
 * measurement no server-side number can make.
 *
 * Two details it would be easy to get wrong:
 *
 * - **The interval re-renders; it does not accumulate.** The elapsed time is read
 *   from the clock at render, so a tick the tab throttled or dropped cannot make
 *   the number lag behind real time.
 * - **`performance.now()`, not `Date.now()`.** It is monotonic, so a clock
 *   correction (NTP, a laptop waking up) cannot make a transcription look
 *   instant — or negative.
 */
export function useTotalLatency(inFlight: boolean): TotalLatency {
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [frozenMs, setFrozenMs] = useState<number | undefined>(undefined);
  // Re-render trigger only — see the doc above.
  const [, tick] = useState(0);
  // Whether `inFlight` has been seen true since the last `start()`. Without it,
  // a start that lands one render before the submission reports itself in flight
  // would freeze the clock at zero instead of running it.
  const began = useRef(false);

  useEffect(() => {
    if (startedAt === undefined || frozenMs !== undefined) return;
    if (inFlight) {
      began.current = true;
      const id = setInterval(() => tick((n) => n + 1), STOPWATCH_TICK_MS);
      return () => clearInterval(id);
    }
    // Measured here rather than at render, so the frozen number is the one at the
    // moment the run settled rather than whenever this page next drew.
    if (began.current) setFrozenMs(performance.now() - startedAt);
  }, [startedAt, frozenMs, inFlight]);

  const start = useCallback(() => {
    began.current = false;
    setFrozenMs(undefined);
    setStartedAt(performance.now());
  }, []);

  const clear = useCallback(() => {
    began.current = false;
    setStartedAt(undefined);
    setFrozenMs(undefined);
  }, []);

  return {
    elapsedMs: frozenMs ?? (startedAt === undefined ? undefined : performance.now() - startedAt),
    running: startedAt !== undefined && frozenMs === undefined,
    start,
    clear,
  };
}

/**
 * The one number the two bars cannot give: click to transcript.
 *
 * Rendered above the run panel rather than inside it, because the stretch it
 * covers starts before there IS a run — in two of the three modes the run does
 * not exist until the upload finishes, so a clock living in the panel would
 * appear only after the wait it is supposed to be timing.
 *
 * `runMs` is the run's own elapsed, once it reports one. The remainder is
 * everything the run could not see: storing the file (or, in streaming mode,
 * minting the upload id), the `POST` that starts the run, and the poll that
 * notices it finished. Clamped at zero, because the two numbers come from two
 * different clocks on two different machines and a few milliseconds the wrong way
 * would otherwise print a negative.
 */
export function TotalLatency({
  elapsedMs,
  running,
  runMs,
}: {
  elapsedMs: number | undefined;
  running: boolean;
  runMs: number | undefined;
}) {
  if (elapsedMs === undefined) return null;
  const outside = runMs === undefined ? undefined : Math.max(0, elapsedMs - runMs);
  return (
    <section className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md border px-5 py-3">
      <h2 className="text-sm font-medium uppercase tracking-[1.2px]">
        {running ? "Elapsed" : "Total latency"}
      </h2>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm tabular-nums">{formatDuration(elapsedMs)}</span>
        {runMs !== undefined && outside !== undefined && (
          <span className="text-xs tabular-nums opacity-60">
            {formatDuration(outside)} before the run · {formatDuration(runMs)} inside it
          </span>
        )}
      </span>
    </section>
  );
}
