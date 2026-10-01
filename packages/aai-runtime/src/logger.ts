// Copyright 2025 the AAI authors. MIT license.

/**
 * The {@link Logger} interface every runtime module logs through, its
 * console-backed and silent implementations, and the process debug flags.
 */

/** Structured context attached to a log line. */
export type LogContext = Record<string, unknown>;

/** Log severity levels a {@link Logger} implements. */
export type LogLevel = "info" | "warn" | "error" | "debug";

/** A single log method: message plus optional structured context. */
export type LogFn = (message: string, ctx?: LogContext) => void;

/**
 * Structured logger interface. Used by tests to suppress output and by
 * consumers to plug in custom logging backends.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createRuntime, type Logger } from "@alexkroman1/aai-runtime";
 * declare const myBackend: { log(level: string, message: string, ctx?: object): void };
 *
 * const myLogger: Logger = {
 *   info: (message, ctx) => myBackend.log("info", message, ctx),
 *   warn: (message, ctx) => myBackend.log("warn", message, ctx),
 *   error: (message, ctx) => myBackend.log("error", message, ctx),
 *   debug: (message, ctx) => myBackend.log("debug", message, ctx),
 * };
 * createRuntime({ agent: agent({ name: "My Agent" }), env: {}, logger: myLogger });
 * ```
 */
export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

function consoleLog(fn: typeof console.log): LogFn {
  // ISO-8601 prefix on every line: the questions worth asking of a voice
  // session are timing ones (endpointing, stalls), so a line must say "when".
  return (message, ctx) => {
    const at = new Date().toISOString();
    if (ctx) fn(at, message, ctx);
    else fn(at, message);
  };
}

/**
 * Parse a debug-flag env value (`AAI_DEBUG`): `"1"` / `"true"` enable it.
 * @internal
 */
export function isDebugEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Whether debug logging is enabled for this process: `AAI_DEBUG=1` or the
 * `LOG_LEVEL=DEBUG` convention `aai-server/_debug-log.ts` already uses.
 *
 * Read once at module load — it gates per-message hot paths (audio frames,
 * stream deltas), so callers must not pay a `process.env` lookup per call.
 * Hot-path call sites also use this flag to skip building expensive log
 * payloads (e.g. `JSON.stringify` of full wire messages) entirely.
 *
 * @internal
 */
export const debugLoggingEnabled: boolean =
  isDebugEnv(process.env.AAI_DEBUG) || process.env.LOG_LEVEL === "DEBUG";

/**
 * Whether the per-interim STT logs are wanted (`AAI_DEBUG_PARTIALS=1`).
 *
 * Separate from {@link debugLoggingEnabled} because interims are the highest
 * volume line in a voice session by an order of magnitude — one per ~200ms of
 * speech, each a revision of the last — and they drown the turn-level events
 * that debugging usually needs. Off even when `AAI_DEBUG=1`.
 *
 * Note this does NOT gate the AssemblyAI turn trace, which carries
 * `endOfTurnConfidence` and is the raw material for measuring an end-of-turn
 * policy. Silencing the redundant copy is the point; losing the data is not.
 *
 * @internal
 */
export const debugPartialsEnabled: boolean = isDebugEnv(process.env.AAI_DEBUG_PARTIALS);

const noopLog: LogFn = () => undefined;

/**
 * Build a console-backed {@link Logger}. `debug` is a live `console.debug`
 * only when debug logging is enabled (see {@link debugLoggingEnabled});
 * otherwise it is a no-op so per-message hot-path logs cost nothing.
 *
 * @internal
 */
export function createConsoleLogger(debug: boolean = debugLoggingEnabled): Logger {
  return {
    info: consoleLog(console.log),
    warn: consoleLog(console.warn),
    error: consoleLog(console.error),
    debug: debug ? consoleLog(console.debug) : noopLog,
  };
}

/**
 * Default console-backed logger. Debug output requires `AAI_DEBUG=1`.
 * @internal
 */
export const consoleLogger: Logger = createConsoleLogger();

/**
 * A logger that drops every line.
 *
 * Not in `_test-utils.ts`: the fuzz harnesses are not `.test.ts` files, so
 * `tsconfig.build.json` compiles them, and importing the vitest-backed helpers
 * would drag `@vitest/spy` types into the published `.d.ts` graph.
 *
 * NO-OPS rather than spies: a shared mock would carry call history across
 * tests, so `expect(logger.error).toHaveBeenCalled()` could be satisfied by a
 * line some earlier test logged.
 *
 * @internal
 */
export const silentLogger: Logger = {
  debug: noopLog,
  info: noopLog,
  warn: noopLog,
  error: noopLog,
};
