// Copyright 2026 the AAI authors. MIT license.
/**
 * This package's one way to write a log line.
 *
 * It replaces 70 direct `console.*` calls across 28 modules. What that cost was
 * not hypothetical: with no seam to intercept, the only way to keep a spec quiet
 * was `spyOn(console, …)`, and 39 of this repo's silencing spies existed for
 * exactly that — test scaffolding standing in for a missing abstraction, in the
 * one package that runs unattended in production.
 *
 * ## The `Logger` type is the SDK's, deliberately
 *
 * `@alexkroman1/aai-runtime` already publishes `Logger`, `LogLevel` and
 * `consoleLogger`, and the runtime inside every guest logs through them. A
 * second interface here would mean the platform and the agents it hosts
 * describe a log line two ways, and any future sink would have to satisfy both.
 * So this module adds only what the SDK's does not have: a NAMESPACE, and a
 * process-wide swap.
 *
 * ## Namespaces, not free-form prefixes
 *
 * `createLogger("sandbox.broker")` and every line it writes carries
 * `sandbox.broker`. The call sites it replaced spelled their own context into
 * the message when they bothered at all — `Sandbox directory lookup failed for
 * ${slug}` — so the same subsystem was greppable under three different phrases
 * and some lines were attributable to nothing. A namespace is one token, chosen
 * once per module, and it survives someone rewording the message.
 *
 * ## The swap is a SINK, not a spy
 *
 * {@link setLogSink} replaces the destination for the whole process and returns
 * its own undo. A namespaced logger reads the sink at CALL time rather than
 * capturing it, which is what makes that work: nearly every consumer here is a
 * module-level `const log = createLogger(…)` evaluated at import, long before a
 * spec gets to install anything.
 *
 * Tests should reach for `silenceLogs()` (`test-utils.ts`) rather than this —
 * it registers its own restore.
 *
 * @module
 */

import type { LogContext, Logger } from "@alexkroman1/aai-runtime";
import { consoleLogger } from "@alexkroman1/aai-runtime/internal";

export type { LogContext, LogFn, Logger, LogLevel } from "@alexkroman1/aai-runtime";

/**
 * Where lines go. Mutable module state, which is the point — see the header.
 *
 * `consoleLogger`'s `debug` is already a no-op unless `AAI_DEBUG=1` or
 * `LOG_LEVEL=DEBUG`, which is the same gate `_debug-log.ts` used to implement
 * by hand for this package alone.
 */
let sink: Logger = consoleLogger;

/**
 * Send every subsequent line to `next`. Returns the undo.
 *
 * Process-wide by construction: there is one stdout, and a per-module override
 * would leave a spec asserting on a subset of the lines its subject wrote.
 */
export function setLogSink(next: Logger): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/**
 * A logger bound to `namespace` — one per module, at module scope.
 *
 * Namespaces are dotted and coarse-to-fine (`sandbox.retire`,
 * `platform.events`, `workflow.wake`), so a grep for `sandbox.` finds the
 * subsystem and a grep for the whole token finds the module.
 */
export function createLogger(namespace: string): Logger {
  const write = (level: keyof Logger) => (msg: string, ctx?: LogContext) => {
    // Read `sink` here, not at construction: these are built at import time.
    if (ctx === undefined) sink[level](`${namespace} ${msg}`);
    else sink[level](`${namespace} ${msg}`, ctx);
  };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

/** A sink that records instead of printing. For specs that assert on lines. */
export type RecordedLine = { level: keyof Logger; msg: string; ctx?: LogContext };

/** Build a recording sink plus the array it fills. */
export function recordingSink(): { sink: Logger; lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const record =
    (level: keyof Logger) =>
    (msg: string, ctx?: LogContext): void => {
      lines.push(ctx === undefined ? { level, msg } : { level, msg, ctx });
    };
  return {
    lines,
    sink: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}
