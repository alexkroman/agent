// Copyright 2026 the AAI authors. MIT license.
/**
 * Where `aai start`'s RUNTIME writes its diagnostics — the session log, the
 * "Session mode resolved" dump, "Serving" — as opposed to this CLI's own lines,
 * which go through the `Ui` seam.
 *
 * @module
 */

import type { LogFn, Logger } from "@alexkroman1/aai-runtime";
import { consoleLogger } from "@alexkroman1/aai-runtime/internal";

/**
 * The runtime's logger for `aai start`: the console logger in human mode, and
 * in JSON mode the same lines on STDERR.
 *
 * `console.log` is stdout, so in JSON mode the runtime's boot dump landed ahead
 * of the one result line the command owes there — the hazard
 * `createDevLogger` (`_dev-env.ts`) fixed for `aai dev`. It matters more here:
 * JSON mode is auto-selected without a TTY, which is every container `aai
 * start` runs in. Unlike the dev logger this keeps the console formatting and
 * its ISO timestamps (a server's log is read by time) by sending info through
 * `console.warn`, the console logger's stderr writer. `debug` stays as it is:
 * it is silent unless `AAI_DEBUG` asks for it.
 */
export function startLogger(silenced: boolean, base: Logger = consoleLogger): Logger {
  if (!silenced) return base;
  return { info: base.warn, warn: base.warn, error: base.error, debug: base.debug };
}

/**
 * A `--workers` worker's logger: every line tagged `[worker N]` with its slot,
 * and slot 0 alone saying what happens while it boots.
 *
 * Without the tag, a session's lines from four workers interleave with nothing
 * to say which process — or which `/workers` row — wrote them. Without the
 * quieting, `--workers auto` on a 32-core box printed the multi-line
 * "Session mode resolved" dump, "Serving" and the uploads notice 32 times: they
 * are a function of the build and its env, identical in every slot, so one
 * copy says everything. Only INFO is quieted, and only until {@link booted};
 * a warning or error at boot can be one slot's own, and after boot info is the
 * session log, which is every slot's own.
 */
export function workerLogger(base: Logger, slot: number): { logger: Logger; booted(): void } {
  let quiet = slot !== 0;
  const tag =
    (fn: LogFn): LogFn =>
    (message, ctx) =>
      fn(`[worker ${slot}] ${message}`, ctx);
  const info = tag(base.info);
  return {
    logger: {
      info: (message, ctx) => {
        if (!quiet) info(message, ctx);
      },
      warn: tag(base.warn),
      error: tag(base.error),
      debug: tag(base.debug),
    },
    booted: () => {
      quiet = false;
    },
  };
}
