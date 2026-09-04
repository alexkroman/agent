// Copyright 2025 the AAI authors. MIT license.

/**
 * Runtime dependencies injected into the session pipeline.
 *
 * Defines the {@link Logger} interface, a default {@link consoleLogger},
 * and the {@link S2sConfig} for Speech-to-Speech endpoint configuration.
 */

import {
  ASSEMBLYAI_S2S_SAMPLE_RATE,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
} from "@alexkroman1/aai/host-internal";

/** Structured context attached to log messages. */
/** Structured context attached to a log line. */
export type LogContext = Record<string, unknown>;

/** Log severity levels a {@link Logger} implements. */
export type LogLevel = "info" | "warn" | "error" | "debug";

/** A single log method: message plus optional structured context. */
export type LogFn = (msg: string, ctx?: LogContext) => void;

/**
 * Structured logger interface. Used by tests to suppress output and by
 * consumers to plug in custom logging backends.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createRuntime, type Logger } from "@alexkroman1/aai-runtime";
 * declare const myBackend: { log(level: string, msg: string, ctx?: object): void };
 *
 * const myLogger: Logger = {
 *   info: (msg, ctx) => myBackend.log("info", msg, ctx),
 *   warn: (msg, ctx) => myBackend.log("warn", msg, ctx),
 *   error: (msg, ctx) => myBackend.log("error", msg, ctx),
 *   debug: (msg, ctx) => myBackend.log("debug", msg, ctx),
 * };
 * createRuntime({ agent: agent({ name: "My Agent" }), env: {}, logger: myLogger });
 * ```
 */
export type Logger = Record<LogLevel, LogFn>;

function consoleLog(fn: typeof console.log): LogFn {
  // ISO-8601 prefix on every line. Without it these logs answer "what
  // happened" but not "when", and the questions worth asking of a voice
  // session are all timing ones — how long endpointing took, how much lead an
  // end-of-turn confidence threshold would buy, where a stall sat. Cheap
  // enough for the debug hot path: one `toISOString` per emitted line, and
  // `debug` is a no-op unless AAI_DEBUG is set.
  return (msg, ctx) => {
    const at = new Date().toISOString();
    if (ctx) fn(at, msg, ctx);
    else fn(at, msg);
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
 * Beside {@link consoleLogger} because the harnesses, the eval session and the
 * published `/testing` runner all need one and there were SEVEN copies of these
 * four lines — one of which already carried the comment "one silent logger
 * rather than the second copy of six lines".
 *
 * Here rather than in `_test-utils.ts`, which is the version several of those
 * copies deliberately refused: the fuzz harnesses are not `.test.ts` files, so
 * `tsconfig.build.json` compiles them, and importing the vitest-backed helpers
 * drags `@vitest/spy` types into the published `.d.ts` graph and fails the build.
 *
 * NO-OPS rather than spies, which is the other reason a copy existed: a shared
 * mock would carry call history across tests, so `expect(logger.error)
 * .toHaveBeenCalled()` could be satisfied by a line some earlier test logged.
 * Against a non-mock that assertion fails loudly and names the reason instead.
 *
 * @internal
 */
export const silentLogger: Logger = {
  debug: noopLog,
  info: noopLog,
  warn: noopLog,
  error: noopLog,
};

/**
 * Speech-to-Speech (S2S) endpoint configuration.
 *
 * Controls which AssemblyAI real-time WebSocket endpoint to connect to and
 * the audio sample rates for input (microphone → STT) and output (TTS → speaker).
 */
export type S2sConfig = {
  /** The WebSocket URL of the S2S real-time endpoint. */
  wssUrl: string;
  /** Sample rate in Hz for audio sent to STT (microphone capture). */
  inputSampleRate: number;
  /** Sample rate in Hz for TTS audio received from the server. */
  outputSampleRate: number;
};

/**
 * Default S2S endpoint configuration.
 * @internal
 */
export const DEFAULT_S2S_CONFIG: S2sConfig = {
  wssUrl: "wss://agents.assemblyai.com/v1/ws",
  inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
  outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
};

/**
 * Force an {@link S2sConfig} onto the one sample rate AssemblyAI's Voice Agent
 * API accepts ({@link ASSEMBLYAI_S2S_SAMPLE_RATE}) — call it only when the
 * session will run on that transport.
 *
 * `S2sConfig.inputSampleRate` serves three consumers with three contracts: the
 * pipeline's STT stage (16 kHz is right there, and cheaper), OpenAI Realtime
 * (which honours whatever rate we declare), and this service (which honours
 * nothing and accepts only 24 kHz). One field, three contracts — so the rate
 * cannot be fixed by changing {@link DEFAULT_S2S_CONFIG}, which would move the
 * pipeline's STT to 24 kHz too. It is pinned per transport instead, and the
 * pinned rates are what `buildReadyConfig` advertises, so a client that
 * captures off that frame is correct by construction.
 *
 * **Pinning is necessary and NOT sufficient**, which is the trap this function
 * cannot fix on its own. It makes every number in the stack say 24 kHz; it
 * cannot make a client's bytes be 24 kHz. A client that ignores the ready frame
 * keeps sending what it always sent, and the service — which honours no
 * declaration — decodes it at 24 kHz regardless, silently. Measured: 16 kHz
 * audio relabelled as 24 kHz produced `session.ready` and then nothing at all
 * on 4 of 5 live sessions (a mangled fragment on the fifth), and a tau2 retail
 * run scored 2/25 with the pin in place. So a host-mode client that DECLARES a
 * rate this transport cannot honour has its handshake REJECTED rather than
 * silently overridden — see `assertHostRatesSupported` in `host-mode.ts`. This
 * function's warn covers the other caller: an operator passing `s2sConfig` to
 * `createRuntime` directly, where there is no handshake to fail.
 *
 * @internal
 */
export function pinAssemblyS2sRates(config: S2sConfig, log?: Logger): S2sConfig {
  const rate = ASSEMBLYAI_S2S_SAMPLE_RATE;
  if (config.inputSampleRate === rate && config.outputSampleRate === rate) return config;
  log?.warn("S2S sample rates pinned to the Voice Agent API's only supported rate", {
    requestedInputSampleRate: config.inputSampleRate,
    requestedOutputSampleRate: config.outputSampleRate,
    sampleRate: rate,
  });
  return { ...config, inputSampleRate: rate, outputSampleRate: rate };
}
