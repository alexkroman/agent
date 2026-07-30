// Copyright 2026 the AAI authors. MIT license.
// Interpretation of the Vercel AI SDK `streamText` `fullStream` parts — text
// deltas, tool calls/results, errors — fanned out to the transcript, TTS, and
// observability sinks, plus the dead-air cover that keeps a caller from
// hearing silence while a tool chain runs.
//
// Split out of `pipeline-stream.ts`, which owns the turn-level plumbing
// (streamText invocation, TTS coalescing and flush, audio conversion).

import { APICallError, RetryError } from "ai";
import {
  DEAD_AIR_COVER_PHRASES,
  DEFAULT_DEAD_AIR_COVER_MS,
  DEFAULT_HOLD_PHRASE,
} from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import { capToolResult, errorMessage, toArgsRecord } from "../../sdk/utils.ts";
import { createRestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";

/** A single `fullStream` part from `streamText`. */
export type StreamPart = {
  readonly type: string;
  readonly text?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly error?: unknown;
};

/** Dependencies the stream-part handler needs from the owning transport. */
type StreamPartHandlerDeps = {
  /** Receives each assistant text delta (accumulated into the transcript). */
  onDelta: (delta: string) => void;
  /** Forwards text to the active TTS session (no-op if none). */
  sendTtsText: (text: string) => void;
  /**
   * A speech segment ended — see {@link TtsTextCoalescer.boundary}. Omitted when
   * `sendTtsText` does no batching, in which case there is nothing to release.
   */
  onTtsBoundary?: (() => void) | undefined;
  /** Observability-only tool-call notification. */
  onToolCall: (callId: string, name: string, args: Record<string, unknown>) => void;
  /** Tool-result completion, so the client UI can flip pending → done. */
  onToolCallDone?: ((callId: string, result: string) => void) | undefined;
  /** Report an LLM-stream error. */
  emitError: (code: SessionErrorCode, message: string) => void;
  /**
   * Spoken when the model's first action in a turn is a tool call with no
   * preceding text — guarantees the caller hears something instead of dead
   * air while the tool runs, even if the model skips the prompt's preamble.
   * Defaults to {@link DEFAULT_HOLD_PHRASE}; set `""` to disable, which also
   * disables the time-based dead-air cover ({@link DEAD_AIR_COVER_PHRASES}).
   */
  holdPhrase?: string | undefined;
  /**
   * The owning turn's abort signal. The dead-air cover is a real timer, and a
   * barge-in can abort the turn while a tool execution has the `fullStream`
   * read parked — deferring `dispose()` for seconds. The signal lets the
   * armed timer die with the turn instead of speaking filler into the
   * post-cancel silence (and polluting the interrupted-turn transcript).
   */
  signal?: AbortSignal | undefined;
  log: Logger;
  sid: string;
};

/** Max `responseBody` characters kept in a log line — providers pad error JSON. */
const MAX_LOGGED_RESPONSE_BODY = 300;

/**
 * Compact HTTP diagnostics for a failed LLM call, for the one log line the
 * failure gets (see {@link createStreamPartHandler}'s `error` case).
 *
 * An `APICallError`'s `message` alone is the bare HTTP status text
 * ("Internal Server Error"), which cannot be acted on: whether a provider
 * outage is worth reporting upstream turns on the status code and the
 * provider's own request id, and which endpoint was even called turns on the
 * URL. Retries wrap the last attempt in a `RetryError`, whose message
 * ("Failed after 3 attempts…") hides all of it one level down.
 *
 * Returns `{}` for anything that is not an HTTP failure — a tool error, an
 * abort, a malformed-response error — so the caller can spread it
 * unconditionally.
 */
export function llmErrorDetails(error: unknown): Record<string, unknown> {
  const call = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(call)) return {};
  const requestId = call.responseHeaders?.["x-request-id"];
  return {
    statusCode: call.statusCode,
    url: call.url,
    ...(requestId ? { requestId } : {}),
    ...(call.responseBody
      ? { responseBody: call.responseBody.slice(0, MAX_LOGGED_RESPONSE_BODY) }
      : {}),
  };
}

/** Stateful per-turn stream-part handler — see {@link createStreamPartHandler}. */
export type StreamPartHandler = {
  /** Interpret one `fullStream` part. */
  handle(part: StreamPart): void;
  /** Release turn-scoped resources (timers). Idempotent; call when the turn ends. */
  dispose(): void;
  /**
   * An `error` part arrived during this turn.
   *
   * A provider failure reaches the host two different ways: as this stream part
   * (logged "LLM stream error") and, when it leaves the turn with no output, as
   * a thrown `No output generated`. A gateway 500 produces both. The caller
   * speaks a recovery phrase on either, so it needs the part-level signal too —
   * the stream can otherwise end "successfully" having emitted nothing but an
   * error.
   */
  errored(): boolean;
};

/**
 * Stateful per-turn handler for `streamText` `fullStream` parts.
 *
 * Tracks text-segment boundaries so that consecutive segments — which the
 * Vercel SDK emits across tool-call hops as `text-end` followed later by a
 * fresh `text-start` — don't fuse into "...up.Got it" when concatenated for
 * the transcript or streamed to TTS. When a boundary is crossed and neither
 * side carries whitespace, a single space is injected into both streams.
 */
export function createStreamPartHandler(deps: StreamPartHandlerDeps): StreamPartHandler {
  const { onDelta, sendTtsText, onToolCall, onToolCallDone, emitError, signal, log, sid } = deps;
  const holdPhrase = deps.holdPhrase ?? DEFAULT_HOLD_PHRASE;
  const ttsBoundary = deps.onTtsBoundary ?? ((): void => undefined);
  let pendingSeparator = false;
  let lastChar = "";
  // Track whether the model has spoken any text this turn, and whether we've
  // already injected the hold phrase — so it fires at most once, only when the
  // turn opens with a tool call and no speech.
  let spokeText = false;
  // An `error` part arrived — see StreamPartHandler.errored.
  let errored = false;
  let holdEmitted = false;
  // Dead-air cover: how many fillers this turn has spoken, which sets both the
  // next phrase and the (exponentially backed-off) wait before it.
  let coverCount = 0;
  const coverEnabled = holdPhrase.length > 0;

  function emitText(delta: string): void {
    if (delta.length === 0) return;
    let out = delta;
    if (pendingSeparator) {
      pendingSeparator = false;
      const boundaryHasSpace = lastChar === "" || /\s/.test(lastChar) || /^\s/.test(out);
      if (!boundaryHasSpace) out = ` ${out}`;
    }
    lastChar = out.slice(-1);
    onDelta(out);
    sendTtsText(out);
  }

  /**
   * Speak the next filler, then schedule the one after it.
   *
   * The buffered-text release matters as much as the phrase: nothing else will
   * arrive to flush the coalescer until the tool chain ends, and that silence
   * is precisely what is being covered.
   */
  const deadAir = createRestartableTimer((): void => {
    // Fire-time re-check, matching the transport's other timers: the abort
    // listener below clears the timer, but a callback already dispatched (or
    // an abort that raced the arm) must still no-op.
    if (signal?.aborted) return;
    const phrase = DEAD_AIR_COVER_PHRASES[coverCount % DEAD_AIR_COVER_PHRASES.length] ?? "";
    coverCount += 1;
    emitText(phrase);
    pendingSeparator = true;
    ttsBoundary();
    armCover();
  });

  /**
   * Open a cover window. The wait doubles per filler already spoken, so a
   * chain that runs long enough to need a fourth reminder gets it at a pace
   * that reads as patience rather than a stuck loop.
   */
  function armCover(): void {
    if (!coverEnabled || signal?.aborted) return;
    deadAir.arm(DEFAULT_DEAD_AIR_COVER_MS * 2 ** coverCount);
  }

  // Kill the armed cover the moment the turn aborts rather than at dispose(),
  // which a tool execution that ignores its abort signal defers for seconds.
  const onAbort = (): void => deadAir.clear();
  signal?.addEventListener("abort", onAbort, { once: true });

  function dispose(): void {
    signal?.removeEventListener("abort", onAbort);
    deadAir.clear();
  }

  function emitToolResult(part: StreamPart): void {
    // Inline execution finished — surface completion so the client UI can
    // flip the tool-call from "pending" to "done". Schema requires a
    // string result capped at MAX_TOOL_RESULT_CHARS.
    const callId = part.toolCallId ?? "";
    if (!callId) return;
    const raw =
      (part as { output?: unknown; result?: unknown }).output ??
      (part as { result?: unknown }).result ??
      "";
    const str = typeof raw === "string" ? raw : JSON.stringify(raw);
    onToolCallDone?.(callId, capToolResult(str));
  }

  function handle(part: StreamPart): void {
    switch (part.type) {
      case "text-delta": {
        const t = part.text ?? "";
        if (t.length > 0) {
          spokeText = true;
          // The model is speaking again — whatever gap was open just closed.
          deadAir.clear();
        }
        emitText(t);
        return;
      }
      case "text-end":
        pendingSeparator = true;
        // This segment is finished, so nothing more will arrive to batch with
        // what is buffered — release it now rather than across the gap that
        // usually follows (a tool call).
        ttsBoundary();
        return;
      case "tool-call": {
        // Guarantee the caller hears a hold phrase if the model jumps straight
        // to a tool call without speaking. Fire once per turn; separate it from
        // the model's later reply so they don't fuse.
        if (!(spokeText || holdEmitted) && holdPhrase.length > 0) {
          holdEmitted = true;
          emitText(holdPhrase);
          pendingSeparator = true;
        }
        // Belt-and-braces for a tool call not preceded by `text-end`: the
        // execution window must never start with speech still buffered. Also
        // releases the hold phrase just emitted above.
        ttsBoundary();
        // The execution window is open: from here until the model speaks
        // again, nothing reaches TTS on its own.
        armCover();
        // Observability only — actual execution happens inline via toVercelTools.
        // An invalid tool call carries raw-string input; coerce it so the
        // `tool_call` frame stays schema-valid (a non-record args drops it).
        onToolCall(part.toolCallId ?? "", part.toolName ?? "", toArgsRecord(part.input));
        return;
      }
      case "tool-result":
        emitToolResult(part);
        return;
      case "error": {
        errored = true;
        const msg = errorMessage(part.error);
        log.error("LLM stream error", { message: msg, sid, ...llmErrorDetails(part.error) });
        emitError("llm", msg);
        return;
      }
      default:
        return;
    }
  }

  return { handle, dispose, errored: () => errored };
}
