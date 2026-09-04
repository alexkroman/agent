// Copyright 2026 the AAI authors. MIT license.
// Interpretation of the Vercel AI SDK `streamText` `fullStream` parts — text
// deltas, tool calls/results, errors — fanned out to the transcript, TTS, and
// observability sinks, plus the dead-air cover that keeps a caller from
// hearing silence while a tool chain runs.
//
// Split out of `pipeline-stream.ts`, which owns the turn-level plumbing
// (streamText invocation, TTS coalescing and flush, audio conversion).

import {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEFAULT_DEAD_AIR_COVER_MS,
} from "@alexkroman1/aai/host-internal";
import { capToolResult, toArgsRecord } from "@alexkroman1/aai/internal";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { APICallError, RetryError } from "ai";
import { createRestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";
import type { EmitError, SendTtsText } from "./types.ts";

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
  /** Forwards text to the active TTS session (no-op if none), carrying `record`. */
  sendTtsText: SendTtsText;
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
  emitError: EmitError;
  /**
   * How long the turn may send nothing to TTS before filler is spoken —
   * {@link DEAD_AIR_OPENING_PHRASE} for the turn's opening gap,
   * {@link DEAD_AIR_COVER_PHRASES} thereafter. Defaults to
   * {@link DEFAULT_DEAD_AIR_COVER_MS}; `0` disables the cover outright.
   */
  deadAirCoverMs?: number | undefined;
  /**
   * The owning turn's abort signal. The dead-air cover is a real timer, and a
   * barge-in can abort the turn while a tool execution has the `fullStream`
   * read parked — deferring `dispose()` for seconds. The signal lets the
   * armed timer die with the turn instead of speaking filler into the
   * post-cancel silence (and polluting the interrupted-turn transcript).
   */
  signal?: AbortSignal | undefined;
  /**
   * Is the caller speaking right now? Filler is silence-cover, so playing it
   * over a live utterance is worse than the silence it exists to hide: the
   * caller hears the agent talk across them, and (measured on EVA's
   * turn-taking metric) it registers as an agent interruption — 1.5s of
   * simultaneous speech on one turn, scored 0.13 out of 1.
   *
   * This is the case `interruptionMinDurationMs` deliberately leaves open: a
   * continuation too short to count as a barge-in does not cancel the reply, so
   * without this check the filler talks over it. Omitted by callers with no
   * speech tracking, which keeps the filler unconditional as before.
   */
  callerSpeaking?: (() => boolean) | undefined;
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
  return {
    statusCode: call.statusCode,
    url: call.url,
    ...omitUndefined({
      requestId: call.responseHeaders?.["x-request-id"],
      responseBody: call.responseBody?.slice(0, MAX_LOGGED_RESPONSE_BODY),
    }),
  };
}

/**
 * The one sentence a failed LLM call reaches the CALLER as — `error.reported`'s
 * `message`, which a browser client renders verbatim.
 *
 * The sibling of {@link llmErrorDetails}, and split from it along the line
 * between a log line and a banner: that one returns fields for an operator
 * reading a log, this one a sentence for whoever is looking at the screen. Both
 * unwrap a `RetryError` the same way, so the two never disagree about which
 * attempt they are describing.
 *
 * Two things it adds to {@link errorMessage}, which already refuses to answer
 * with an empty string and already names the status and the host:
 *
 * - **A rejected credential says so.** `401`/`403` is the single most likely
 *   first-run failure — a key that is wrong, expired, or never set — and it is
 *   the one that explains itself least: the provider's own body says "Invalid
 *   API key" without saying whose, and the status is a number. Naming the act
 *   ("rejected the API key") is what turns the banner into an instruction.
 * - **The provider is named by the HOST that answered** (via `errorMessage`),
 *   which is as specific as this layer can be honest about: the credential's
 *   ENV VAR name is known only at provider-resolution time
 *   (`providers/_llm-registry.ts`), and the transport is handed a built
 *   `LanguageModel`, not the descriptor it came from.
 *
 * One more rule belongs with it, and it is the reason a caller still saw
 * nothing useful after `errorMessage` stopped answering blank: **a refused call
 * is reported ONCE.** It arrives twice — as the `error` part handled below, and
 * then as a throw, because the AI SDK's `steps` promise rejects with "No output
 * generated. Check the stream for errors." once the stream ends having produced
 * none. The second names no cause, and arriving last it is the sentence a
 * client's banner is LEFT showing. `consumeLlmStream` therefore reports from its
 * catch only when nothing reported from the stream ({@link StreamPartHandler.errored}).
 * Verified against a live 401 through the real gateway client: both frames
 * arrive, in that order.
 *
 * @internal
 */
export function llmErrorSentence(error: unknown): string {
  const call = (RetryError.isInstance(error) ? error.lastError : error) ?? error;
  const described = errorMessage(call);
  if (!APICallError.isInstance(call)) return described;
  if (call.statusCode !== 401 && call.statusCode !== 403) return described;
  return `The LLM provider rejected this agent's API key: ${described}. Check the API key in the agent's environment.`;
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
  const coverMs = deps.deadAirCoverMs ?? DEFAULT_DEAD_AIR_COVER_MS;
  const callerSpeaking = deps.callerSpeaking ?? ((): boolean => false);
  const ttsBoundary = deps.onTtsBoundary ?? ((): void => undefined);
  let pendingSeparator = false;
  let lastChar = "";
  // Has the model spoken any text this turn? Set by the first `text-delta`,
  // and what decides which filler fits the next gap (see the timer body).
  let spokeText = false;
  // An `error` part arrived — see StreamPartHandler.errored.
  let errored = false;
  // Dead-air cover, tracked as two separate counts. `coverCount` is every filler
  // spoken this turn and drives the backoff; `coverPhraseCount` is only the
  // DEAD_AIR_COVER_PHRASES ones and picks the next phrase. Sharing one counter
  // meant the opening phrase consumed a phrase slot, so the caller heard the
  // opening filler and then skipped straight to the second cover phrase.
  let coverCount = 0;
  let coverPhraseCount = 0;

  /**
   * Send text to the caller.
   *
   * `record: false` marks filler — the opening phrase and the dead-air cover
   * cycle. Those are timing artifacts, not dialogue: they exist so a tool chain
   * doesn't sound like a dropped call. They still go to TTS (the caller hears
   * them) and to the interim transcript built from what reaches TTS (the caption
   * matches the audio), but they are kept out of `onDelta`, which accumulates the
   * turn's text for the conversation history, `ctx.messages`, session resume, and
   * the STT provider's agent-context hint.
   *
   * Recording them cost twice: context spent restating "Still working on that.
   * Just a moment longer." across every later turn, and a model shown its own
   * filler as an example of what its turns look like.
   *
   * The flag is load-bearing in a SECOND place now: it rides through to the TTS
   * send, where the heard cursor uses it to decide which characters of what the
   * caller heard may be truncated into history (`pipeline-heard.ts`). Filler is
   * audible — so it moves the heard POSITION — and still never recorded.
   */
  function emitText(delta: string, record = true): void {
    if (delta.length === 0) return;
    let out = delta;
    if (pendingSeparator) {
      pendingSeparator = false;
      const boundaryHasSpace = lastChar === "" || /\s/.test(lastChar) || /^\s/.test(out);
      if (!boundaryHasSpace) out = ` ${out}`;
    }
    lastChar = out.slice(-1);
    if (record) onDelta(out);
    sendTtsText(out, { record });
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
    // The caller is talking — the gap is already filled, by them. Re-arm and
    // cover the next gap instead of speaking across this one.
    if (callerSpeaking()) {
      armCover();
      return;
    }
    // Nothing has reached the caller yet, so this is the turn's OPENING gap
    // rather than a gap between things the model said, and it needs its own
    // phrase — the cycle opens with "I'm still checking on this.", which
    // implies work already narrated and would be the very first words of the
    // turn. `coverCount === 0` is the test rather than a flag of its own: only
    // the FIRST filler of a turn can precede any speech.
    const opening = !spokeText && coverCount === 0;
    let phrase = DEAD_AIR_OPENING_PHRASE;
    if (!opening) {
      phrase = DEAD_AIR_COVER_PHRASES[coverPhraseCount % DEAD_AIR_COVER_PHRASES.length] ?? "";
      coverPhraseCount += 1;
    }
    // Counted either way: it drives the backoff, so an opening filler must
    // still push the next one out. Left uncounted, the next cover came one base
    // window (2s, the base at the time) after the opening phrase — net of its
    // own ~1.3s of audio, under a second of silence between two fillers, which
    // reads as chatter at the very start of the wait.
    coverCount += 1;
    emitText(phrase, false);
    pendingSeparator = true;
    ttsBoundary();
    armCover();
  });

  /**
   * Open a cover window. The wait doubles per filler already spoken, so a short
   * chain does not chatter — then flattens at {@link DEAD_AIR_COVER_MAX_MS} so a
   * long one keeps a steady heartbeat instead of drifting back into the silence
   * this exists to cover. See that constant for the measured cadence.
   *
   * The ceiling is `max(DEAD_AIR_COVER_MAX_MS, coverMs)` rather than the
   * constant, because the base is now the author's: a `deadAirCoverMs` above
   * 8000 would otherwise be clamped BELOW its own base, so an agent asking for
   * one filler every 20s would get the first at 8s.
   */
  function armCover(): void {
    if (coverMs <= 0 || signal?.aborted) return;
    deadAir.arm(Math.min(coverMs * 2 ** coverCount, Math.max(DEAD_AIR_COVER_MAX_MS, coverMs)));
  }

  // Kill the armed cover the moment the turn aborts rather than at dispose(),
  // which a tool execution that ignores its abort signal defers for seconds.
  const onAbort = (): void => deadAir.clear();
  signal?.addEventListener("abort", onAbort, { once: true });

  // Cover the turn's OPENING gap, not just gaps between things the model said.
  // armCover() used to be reachable only from the `tool-call` part and from the
  // timer itself, which left the window between the committed user turn and the
  // model's FIRST stream part uncovered — and unbounded. A slow first token, or
  // a long reasoning phase (which emits reasoning deltas and no text), is then
  // pure dead air for however long it lasts, while the only other filler
  // mechanism waited on a `tool-call` part that had not arrived yet. Measured
  // on tau2-bench retail with gpt-5.5 through the gateway: 31.4s of silence
  // after a committed user turn, ended only by the first tool call finally
  // triggering that filler, while the client kept streaming mic audio into a
  // session that looked healthy from both ends. This handler is constructed as
  // the turn's stream opens, and the first `text-delta` clears the timer, so a
  // turn that answers promptly pays nothing.
  armCover();

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
        // A tool call speaks NO filler of its own. It used to: an immediate
        // hold phrase on the structural bet that a turn opening with a tool
        // call means silence is coming. That bet is paid on every such turn
        // however fast the tool returns, and the case it covers is a strict
        // subset of "nothing audible for `coverMs`" — which the window armed at
        // construction already covers, and covers better. All this branch does
        // now is re-open that window across the execution.
        //
        // Belt-and-braces for a tool call not preceded by `text-end`: the
        // execution window must never start with speech still buffered.
        ttsBoundary();
        // The execution window is open: from here until the model speaks
        // again, nothing reaches TTS on its own.
        //
        // **Only when no window is already running.** `RestartableTimer.arm`
        // clears and re-sets, so an unconditional call here RESTARTS the
        // countdown on every tool call — and the deadline is measured from the
        // last one rather than from the last thing the caller HEARD. A chain
        // whose calls each return inside `coverMs` therefore pushes the
        // deadline out indefinitely and the cover never fires at all, which is
        // the exact silence it exists to break. Measured on tau2-bench retail:
        // the cover fired ZERO times in two tasks while the caller sat through
        // 13.0s and 6.0s of dead air mid-authentication and re-prompted with
        // "Hello?"; across the run, dropped caller turns had gone from 0 in 130
        // to 6.4% of 499 when the prompt's holding-line mandate was retired in
        // favour of this mechanism — which was not covering the case.
        //
        // The re-arm is still needed and still happens: a `text-delta` CLEARS
        // the timer (the caller heard something, so the clock restarts from
        // there), which leaves `pending()` false and lets the next tool call
        // re-open the window. This only declines to move a deadline that is
        // already counting down toward silence the caller is already in.
        if (!deadAir.pending()) armCover();
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
        const msg = llmErrorSentence(part.error);
        log.error("LLM stream error", { message: msg, sid, ...llmErrorDetails(part.error) });
        // NON-fatal: `errored` above ends this TURN (the outcome speaks
        // `errorPhrase`), and the session keeps taking turns after it.
        emitError("llm", msg, { fatal: false });
        return;
      }
      default:
        return;
    }
  }

  return { handle, dispose, errored: () => errored };
}
