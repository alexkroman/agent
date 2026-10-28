// Copyright 2026 the AAI authors. MIT license.
// One `streamText` turn: assembling the request, consuming its `fullStream`
// through the shared part handler, and collecting the step messages history
// needs.
//
// Split out of `../output/tts.ts` (which keeps the TTS-side plumbing —
// coalescing, flush-wait, the playback message conversion) so that this module
// can hold BOTH the ordinary path and the preemptive-generation path without
// either file passing the length cap.
//
// The split is load-bearing for preemption's correctness, not just for line
// count: `startLlmStream` is the ONE place a `streamText` request is assembled,
// and the speculative launcher calls it with a different tool set and nothing
// else different. That is what makes adopting a speculative stream into a real
// turn legitimate — see `../speech/speculation.ts`.

import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { type ModelMessage, stepCountIs, streamText } from "ai";
import {
  composePreparers,
  forceFinalAnswer,
  resetToolChoiceAfterFirstStep,
  toolErrorBudget,
} from "../../../_prepare-step.ts";
import { createToolCallRepair, withFatalSignal } from "../../../tools/index.ts";
import { resolveSystemPrompt } from "../../types.ts";
import { createTtsTextCoalescer } from "../output/index.ts";
import {
  createStreamPartHandler,
  llmErrorDetails,
  llmErrorSentence,
  type StreamPart,
  type StreamPartHandler,
} from "../reply/index.ts";
import { drainEntries, partsAsEntries } from "./drain.ts";
import { smoothTextStream } from "./smooth.ts";
import { bindToolSpeech, stepMessages } from "./tool-speech.ts";
import { createTurnTrace } from "./trace.ts";
import type {
  AdoptedLlmStream,
  ConsumeLlmStreamParams,
  LlmRequest,
  LlmStreamResult,
  StartedLlmStream,
  StepResult,
  TapeEntry,
} from "./types.ts";

/**
 * Longest a response stream may stay silent — before its first chunk, and
 * between chunks — before the request is abandoned.
 *
 * **Without it the only deadline was undici's 300 s body timeout.** A gateway
 * answered `200`, sent its headers, and then nothing: the turn sat for 5 min
 * 3 s (tau2 retail task 104), the dead-air filler looping over ~20 unanswered
 * caller turns, until undici cut the body and the SDK reported "Failed to
 * process successful response (HTTP 200)". The AI SDK's `maxRetries` cannot
 * see that case: it retries a request that fails, and this one had succeeded.
 *
 * 15 s, from the same benchmark's healthy turns: across 3,149 committed caller
 * turns in two 114-task runs, the slowest first model output came 12.3 s after
 * the turn committed (and that includes STT finalization); across 6,062 gaps
 * inside streaming replies the longest was 9.8 s. So neither clock has fired
 * on a healthy turn, and a stall is cut 20x sooner than undici would.
 */
export const LLM_STALL_TIMEOUT_MS = 15_000;

/**
 * Every TYPE this module's two functions speak — the request parameters, the
 * turn result, the adopted-speculation handover and its tape — lives in
 * `types.ts`, split off when this file passed the source-length
 * cap. They carry more argument than code (each field is a decision about what
 * one turn may say), and separating them leaves this file as the two functions
 * themselves. Re-exported here, so no importer moved.
 */
export type {
  AdoptedLlmStream,
  ConsumeLlmStreamParams,
  LlmRequest,
  LlmStreamResult,
  SharedLlmRequest,
  StartedLlmStream,
  StepResult,
  TapeEntry,
} from "./types.ts";

/**
 * Assemble and launch one `streamText` request.
 *
 * **The only `streamText` call site in the pipeline, and that is a correctness
 * property rather than tidiness.** Preemptive generation adopts a stream
 * started from an interim transcript into the real turn, which is legitimate
 * only because the speculative request is identical to the real one except for
 * its last user message and its tool set. A second call site anywhere would let
 * a future parameter (a provider option, a `stopWhen` change) reach one path and
 * not the other, and adopted turns would silently run under different settings
 * — see the request-parity spec in `stream.test.ts`.
 */
export function startLlmStream(req: LlmRequest): StartedLlmStream {
  const result = streamText({
    model: req.llm,
    // Resolved HERE, at request-assembly time, so the request carries the phase
    // the turn is actually in. The restart pass below (late poison) therefore
    // re-resolves too, which is right: it is a new request, and the old one's
    // prompt died with the run it was assembled for.
    system: resolveSystemPrompt(req.systemPrompt),
    messages: req.messages,
    // OMITTED, not empty, when this request has no tools — and that is a
    // provider requirement rather than tidiness. Several small conversational
    // models refuse a tool list outright: the AssemblyAI gateway answers
    // `400 {"errors":["model qwen3.5-4b-32k-fast does not support tools"]}` for
    // a request carrying one, and an empty `tools: {}` still serializes to a
    // `tools` key. So a tool-free agent — an agent that declares none, and one
    // whose tools are all gated off — sends no tool key at all. `toolChoice`
    // goes with it: a choice with nothing to choose from is refused by the same
    // providers.
    ...(Object.keys(req.tools).length === 0
      ? {}
      : { tools: req.tools, ...omitUndefined({ toolChoice: req.toolChoice }) }),
    // Temperature only when set — Claude 5 ignores it and warns. The other two
    // follow the same rule for the same reason: an explicit `undefined` is not
    // the same request as an absent key to every provider, and `maxRetries: 0`
    // is a legitimate value a `??` default would swallow.
    ...omitUndefined({
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      maxRetries: req.maxRetries,
    }),
    // Word-coalesce text for TTS, keeping thinking signatures (see pipeline-smooth.ts).
    experimental_transform: smoothTextStream(),
    experimental_repairToolCall: req.repairToolCall,
    // `maxSteps` bounds TOOL-CALLING steps; the budget is one larger so the
    // forced answer step below has somewhere to run. See forceFinalAnswer.
    //
    // The second condition is the whole of "the model is not called at all":
    // a tool whose `complete`/`failed` message carries `role: "assistant"` has
    // already SPOKEN the reply from inside its own `execute`, so the step that
    // produced that tool result is the last one this turn gets. Nothing else
    // would stop it — the SDK's default after a tool result is another model
    // call, which is exactly the round-trip the feature exists to remove.
    // Evaluated after each step, and the latch is set during the step's tool
    // execution, so it is already true when the SDK asks.
    stopWhen: [stepCountIs(req.maxSteps + 1), () => req.toolSpeech?.verbatim() !== undefined],
    // ONE slot, SIX things to say — see `../../../_prepare-step.ts`. Each concern
    // REGISTERS by stage and `composePreparers` layers them in
    // `PREPARER_ORDER` (budget → agent reset → persona → dialog state → the
    // two forced answers), so the precedence is decided there and pinned by
    // its spec, not by the order of this list. Built HERE, per request,
    // because the error budget counts one turn.
    prepareStep: composePreparers([
      { stage: "context-budget", prepare: req.contextBudget },
      {
        stage: "agent-tool-choice",
        prepare: resetToolChoiceAfterFirstStep(req.toolChoice, req.resetToolChoice ?? true),
      },
      { stage: "persona", prepare: req.personaStep },
      { stage: "dialog", prepare: req.dialogStep },
      { stage: "tool-error-budget", prepare: toolErrorBudget(req.log, req.sid) },
      { stage: "force-final-answer", prepare: forceFinalAnswer(req.maxSteps, req.log, req.sid) },
    ]),
    abortSignal: req.signal,
    // A stalled response is a FAILED request, not a slow one — see
    // LLM_STALL_TIMEOUT_MS. Per step, so a tool's own execution time (between
    // steps) is never counted against it.
    timeout: {
      firstChunkMs: req.stallTimeoutMs ?? LLM_STALL_TIMEOUT_MS,
      chunkMs: req.stallTimeoutMs ?? LLM_STALL_TIMEOUT_MS,
    },
    onStepFinish: (step) => {
      // The provider's own counts, folded in before the messages: a step that
      // completes has been billed whether or not the turn survives to use it.
      req.onUsage?.(step.usage);
      // `onStep` is the ONLY way out: each consumer keeps the copy it needs
      // (`consumeLlmStream`'s own array, the speculation's tape), and a second
      // accumulator here was write-only — two collections of one thing, with
      // nothing telling a reader which one a caller holds.
      req.onStep?.(step.response.messages);
    },
    // Every `error` part is delivered to `onError` and to `fullStream` alike, so
    // the handler below is what reports the failure — at error level, with its
    // HTTP diagnostics (see `llmErrorDetails`). Claiming this callback is still
    // mandatory: the SDK's default is `console.error(error)`, which spends ~100
    // log lines on the same event (three nested stack traces plus the entire
    // request body, one console depth level away from the conversation itself).
    // On a host with a bounded log buffer that evicts every other line — which
    // is how a gateway 500 became the only thing visible in production logs, and
    // it now covers SPECULATIVE streams too, where a provider failure on a turn
    // that never existed would evict the logs of the turn that did.
    onError: ({ error }) => {
      req.log.debug("streamText onError", { error: errorMessage(error), sid: req.sid });
    },
  });
  // `result.steps` settles after the stream; the abort/error paths below
  // return without awaiting it, so observe rejections up front — an
  // AbortError landing later must not become an unhandled rejection. The
  // happy path's `await result.steps` still sees the original settlement.
  // Speculations rely on this doubly: every discarded one aborts.
  void Promise.resolve(result.steps).catch(() => undefined);
  return {
    fullStream: result.fullStream as AsyncIterable<StreamPart>,
    steps: Promise.resolve(result.steps),
  };
}

/** Per-turn entry into {@link consumeLlmStream} — see {@link createTurnLlmRunner}. */
export type TurnLlmRunner = (
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  onStepPersisted?: () => void,
  adopted?: AdoptedLlmStream | undefined,
  onRestart?: () => void,
) => Promise<LlmStreamResult>;

/**
 * The session-fixed half of {@link ConsumeLlmStreamParams} — derived by
 * subtraction rather than re-declared, so a new stream parameter cannot be
 * silently dropped here.
 */
export type TurnLlmRunnerDeps = Omit<
  ConsumeLlmStreamParams,
  "repairToolCall" | "signal" | "onDelta" | "onStepPersisted" | "adopted" | "onRestart"
>;

/**
 * Bind a session's fixed `streamText` parameters once, leaving each turn to
 * supply only what is genuinely per-turn: its abort signal and the two
 * accumulation hooks.
 *
 * Session-scoped provider plumbing rather than turn orchestration, so it lives
 * beside {@link consumeLlmStream} instead of in the transport.
 *
 * `messages` is the live LLM-history array, bound once — the history module
 * mutates it in place (push/splice), so the reference stays current.
 */
export function createTurnLlmRunner(deps: TurnLlmRunnerDeps): TurnLlmRunner {
  return (signal, onDelta, onStepPersisted, adopted, onRestart) =>
    consumeLlmStream({
      ...deps,
      // Built per turn so the repair holds THIS turn's signal. Reading the
      // mutable turn state at repair time raced barge-in: settled, the repair
      // ran unsignalled (an orphaned billed call); replaced, it held the NEXT
      // turn's signal.
      repairToolCall: createToolCallRepair({
        model: deps.llm,
        logger: deps.log,
        abortSignal: () => signal,
      }),
      signal,
      onDelta,
      onStepPersisted,
      adopted,
      onRestart,
    });
}

/**
 * One pass's entry stream and step promise: the adopted tape's, or a freshly
 * launched request's.
 *
 * A function rather than an `if`/`else` inside {@link consumeLlmStream} because
 * that function sits at its cognitive-complexity ceiling, and this branch is
 * the most self-contained thing in it. `launch` is a thunk so the request is
 * assembled only on the arm that needs one.
 */
function openPass(
  adopted: AdoptedLlmStream | undefined,
  launch: () => StartedLlmStream,
): { entries: AsyncIterable<TapeEntry>; steps: Promise<readonly StepResult[]> } {
  if (adopted) return { entries: adopted.entries(), steps: adopted.steps() };
  const started = launch();
  return { entries: partsAsEntries(started.fullStream), steps: started.steps };
}

/**
 * Log and report a turn's thrown LLM failure. ONE failure, reported ONCE — when
 * the stream's `error` part already named the cause (`reported`), this throw
 * does not; {@link llmErrorSentence} carries the argument. NON-fatal: this turn
 * is over, the session is not. The caller returns `failed: true`, which speaks
 * `errorPhrase` — "Sorry, I had a problem just then. Could you say that
 * again?" — so reporting the session dead here asked the user to repeat
 * themselves into a released microphone.
 */
function reportLlmFailure(
  err: unknown,
  ctx: {
    reported: boolean;
    emitError: ConsumeLlmStreamParams["emitError"];
    log: ConsumeLlmStreamParams["log"];
    sid: string;
  },
): void {
  const msg = llmErrorSentence(err);
  ctx.log.error("LLM streamText failed", { error: msg, sid: ctx.sid, ...llmErrorDetails(err) });
  if (!ctx.reported) ctx.emitError("llm", msg, { fatal: false });
}

/** {@link settleOrRetry}'s answer for "re-send this pass". */
const RETRY = Symbol("retry");

/**
 * Await a pass's steps, answering {@link RETRY} where its rejection may be
 * re-sent. The AI SDK ends `fullStream` quietly on its own timeout abort, so a
 * stall's `TimeoutError` surfaces HERE rather than from the stream. Re-sent
 * ONCE and only before any output (`canRetry`): a completed step may have run a
 * write tool, and re-sending would run it again. The caller deliberately does
 * NOT call `onRestart` — nothing the model produced reached `onDelta`; what the
 * caller heard was filler, which was really said.
 */
async function settleOrRetry(
  steps: Promise<readonly StepResult[]>,
  canRetry: (err: unknown) => boolean,
): Promise<readonly StepResult[] | typeof RETRY> {
  try {
    return await steps;
  } catch (err: unknown) {
    if (canRetry(err)) return RETRY;
    throw err;
  }
}

/**
 * A stall AFTER a completed step: the stream ends with an `abort` part and
 * `steps` resolves — nothing throws, and the turn would end in silence right
 * after a tool ran. Reported as a failed turn (the caller hears the recovery
 * phrase; the completed steps are kept). Answers whether the turn FAILED —
 * this stall, or an `error` part the handler saw.
 */
function failedOrStalled(
  abortReason: unknown,
  ctx: {
    signal: AbortSignal;
    handler: StreamPartHandler;
    emitError: ConsumeLlmStreamParams["emitError"];
    log: ConsumeLlmStreamParams["log"];
    sid: string;
  },
): boolean {
  if (ctx.signal.aborted || !isStallTimeout(abortReason)) return ctx.handler.errored();
  const msg = llmErrorSentence(abortReason);
  ctx.log.error("LLM stream stalled after output; turn failed", { error: msg, sid: ctx.sid });
  if (!ctx.handler.errored()) ctx.emitError("llm", msg, { fatal: false });
  return true;
}

/**
 * Did this pass end on {@link LLM_STALL_TIMEOUT_MS} before producing anything —
 * so re-sending it repeats nothing the caller heard and nothing a tool did?
 *
 * The AI SDK's timeouts abort with a `TimeoutError` named for the clock that
 * fired ("First chunk timeout…", "Chunk timeout…"). A barge-in is never one:
 * the turn's own signal is checked first.
 */
function isQuietStall(
  err: unknown,
  pass: {
    progress: { output: boolean };
    collected: readonly ModelMessage[];
    signal: AbortSignal;
    /** This turn already used its one retry. */
    retried: boolean;
  },
): boolean {
  if (pass.retried || pass.signal.aborted || pass.progress.output) return false;
  if (pass.collected.length > 0) return false;
  return isStallTimeout(err);
}

/**
 * The AI SDK's first-chunk or chunk clock fired — see {@link LLM_STALL_TIMEOUT_MS}.
 *
 * Two shapes, one event: `result.steps` rejects with the `TimeoutError` itself,
 * while the stream's `abort` part carries it SERIALIZED (the SDK runs the reason
 * through `getErrorMessage`, giving `"TimeoutError: First chunk timeout of …"`).
 */
function isStallTimeout(err: unknown): boolean {
  let text = typeof err === "string" ? err : "";
  if (err instanceof Error) text = `${err.name}: ${err.message}`;
  return /^TimeoutError: .*chunk timeout/i.test(text);
}

/**
 * Run one `streamText` turn against the LLM, fan its stream parts out via
 * {@link createStreamPartHandler}, and return the accumulated response
 * messages plus whether the stream failed.
 *
 * With `adopted` set, no request is launched: the speculation's tape is
 * replayed through the SAME handler and then its live remainder is consumed.
 * Everything downstream — TTS, the transcript, `onStepPersisted` — therefore
 * sees one indistinguishable stream, which is the whole point: adoption
 * connects the tape to the handler, and nothing else about the turn changes.
 */
export async function consumeLlmStream(params: ConsumeLlmStreamParams): Promise<LlmStreamResult> {
  const {
    sendTtsText,
    deadAirCoverMs,
    callerStoppedAt,
    callerSpeaking,
    callbacks,
    emitError,
    log,
    sid,
    signal,
    onDelta,
    onStepPersisted,
    onRestart,
    adopted,
    fatalTool,
    toolSpeech,
  } = params;
  // The REQUEST's signal, which is the turn's plus the fatal-tool latch. The
  // two are deliberately not the same signal: aborting the turn's would make
  // this indistinguishable from a barge-in (an `[interrupted]` tail persisted,
  // no TTS drain, nothing spoken), where what a fatal tool error should produce
  // is a FAILED turn — the caller hears `errorPhrase` and the session lives.
  // `AbortSignal.any` holds its sources weakly, so a settled turn leaves no
  // listener behind on either.
  const requestSignal = withFatalSignal(signal, fatalTool);
  // Batch word-granularity deltas into fewer TTS provider sends; the
  // transcript path (onDelta) keeps full delta granularity.
  let ttsText = createTtsTextCoalescer(sendTtsText);
  let handler: StreamPartHandler | undefined;
  // Where this turn's tool messages go — see `bindToolSpeech`.
  const unbindToolSpeech = bindToolSpeech(toolSpeech, {
    handler: () => handler,
    callerSpeaking,
  });
  // Hoisted rather than written at the handler below, where the conditional
  // costs this function a cognitive-complexity point it does not have. It is
  // OMITTED rather than answering `false` for a caller with no controller, so
  // a tool-less turn's dead-air cover is byte-identical to what it was.
  // `coveredThisTurn`, not `covering`: once a tool has declared its own cover,
  // the generic phrase stays out of the rest of the turn — after the call
  // returns it would only land as a preamble to the answer.
  const toolCovering = toolSpeech === undefined ? undefined : () => toolSpeech.coveredThisTurn();
  // Response messages of completed steps — on the adopted path this module owns
  // the copy, since the speculation's own `collected` is behind the tape.
  const collected: ModelMessage[] = [];
  try {
    // At most two passes: the adopted tape, then — if that tape turns out to
    // hold a tool call — one fresh run with the real, executable tools.
    let useAdopted = adopted;
    // At most one stall retry per turn — see the catch around `drainEntries`.
    let stallRetried = false;
    for (;;) {
      const { entries, steps } = openPass(useAdopted, () =>
        startLlmStream({
          ...params,
          signal: requestSignal,
          onStep: (messages) => {
            collected.push(...messages);
            onStepPersisted?.();
          },
        }),
      );
      handler = createStreamPartHandler({
        onDelta,
        sendTtsText: ttsText.send,
        onTtsBoundary: ttsText.boundary,
        deadAirCoverMs,
        callerStoppedAt: callerStoppedAt?.(),
        // Lets the dead-air cover die with the turn: a barge-in during a tool
        // execution parks the fullStream read, deferring dispose() below.
        signal,
        callerSpeaking,
        // Vapi's "idle messages are disabled during tool calls", in this
        // repo's vocabulary: a tool that declares its own start or delay lines
        // is already covering the gap, so the generic cover stands down rather
        // than speaking a second sentence about one silence.
        toolCovering,
        // `../reply/stream-parts.ts` keeps its own two parameters: it is transport
        // INTERNALS, where an `on*` argument is ordinary function decomposition
        // rather than an observability surface. This is the seam where the two
        // vocabularies meet. `result` arrives already capped (`capToolResult`
        // there), which the wire schema requires.
        onToolCall: (callId, name, args) =>
          callbacks.report({ type: "tool.called", toolCallId: callId, toolName: name, args }),
        onToolCallDone: (callId, result) =>
          callbacks.report({ type: "tool.completed", toolCallId: callId, result }),
        emitError,
        log,
        sid,
      });
      // LATE POISON. `poisoned()` is checked once, at the adoption instant, but
      // poison is a property of the run's WHOLE LIFETIME: the speculation is
      // still streaming when it is adopted, so a `tool-call` can arrive after
      // the check passed. Its tools come from `toDeclaredTools` and have no
      // `execute`, so the AI SDK cannot produce a result and the request dies
      // with "Tool result is missing for tool call <id>" — reported against the
      // REAL turn, which then speaks `errorPhrase` for a reply the model was
      // perfectly capable of giving. Restarting with executable tools is the
      // only repair: the preamble cannot be spliced onto a fresh request (that
      // is the same request-parity argument that makes adoption legitimate in
      // the first place), so the run is abandoned whole.
      const trace = createTurnTrace({
        log,
        sid,
        adopted: useAdopted !== undefined,
        onDone: params.onLlmTiming,
      });
      const progress: { output: boolean; abort?: unknown } = { output: false };
      const { lateToolCall, spokeBeforeRestart } = await drainEntries(entries, handler, {
        adopted: useAdopted !== undefined,
        signal,
        collected,
        onStepPersisted,
        trace,
        progress,
      });
      trace.done({ steps: collected.length, aborted: signal.aborted });
      if (lateToolCall && useAdopted && !signal.aborted) {
        handler.dispose();
        useAdopted.abandon();
        useAdopted = undefined;
        // A speculation is at most one step (nothing can complete without a
        // tool result), so this is empty in practice — cleared rather than
        // trusted, since a partial step must not reach the restarted turn.
        collected.length = 0;
        // Fresh coalescer: the abandoned run's buffered tail never reached TTS
        // and must not splice into the retry, and `firstSent` has to re-arm so
        // the restarted run's first chunk still goes out immediately.
        ttsText = createTtsTextCoalescer(sendTtsText);
        // And the CALLER's accumulation, which this module cannot reach: what
        // the abandoned run put through `onDelta` is about to be said again, and
        // recording it twice is worse than the audio duplication noted below.
        onRestart?.();
        log.info("Pipeline speculation poisoned after adoption; restarting turn", {
          sid,
          // True only when the model spoke BEFORE calling a tool, which the
          // TOOLS prompt section tells it not to do ("Report RESULTS, never
          // intentions"). When it happens anyway the caller hears that opening
          // twice, since a clean restart regenerates it.
          spokeBeforeRestart,
        });
        continue;
      }
      // The model is done: no filler may fire during the flush or the wait for
      // `result.steps` below, both of which follow the last stream part.
      handler.dispose();
      // Aborted turns skip the flush — TTS is being cancelled anyway.
      if (signal.aborted) return { messages: collected, failed: false };
      ttsText.flush();
      // Gather every step's response messages (assistant tool-call + `tool`
      // result + text) so tool context carries into the next turn. Top-level
      // `result.response.messages` is final-step only and drops the tool call.
      // Preferred over `collected` on the happy path in case a final step
      // resolves after the stream ends but before its onStepFinish fires.
      // STALL RETRY — see settleOrRetry and LLM_STALL_TIMEOUT_MS.
      const settled = await settleOrRetry(steps, (err) =>
        isQuietStall(err, { progress, collected, signal, retried: stallRetried }),
      );
      if (settled === RETRY) {
        stallRetried = true;
        useAdopted?.abandon();
        useAdopted = undefined;
        ttsText = createTtsTextCoalescer(sendTtsText);
        log.warn("LLM stream stalled before any output; re-sending once", { sid });
        continue;
      }
      return {
        messages: stepMessages(settled, toolSpeech),
        // A stream can end without throwing having emitted nothing but an `error`
        // part, which is still a turn the caller never heard a reply to.
        // So can a stall after a completed step — see failedOrStalled.
        failed: failedOrStalled(progress.abort, { signal, handler, emitError, log, sid }),
      };
    }
  } catch (err: unknown) {
    // A barge-in is not a failure — it has its own recovery path, and an
    // apology on top of a deliberate interruption would be wrong.
    if (signal.aborted) return { messages: collected, failed: false };
    // A fatal tool error IS one, and it is checked before the generic LLM
    // reporting below: what reaches here is the `AbortError` this module raised
    // on itself (aborting `requestSignal` rejects `result.steps`, which the
    // happy path awaits), whose message names neither the tool nor the reason.
    //
    // Reported as a `tool` error rather than an `llm` one — the model did
    // nothing wrong — and NON-fatally, on this transport's standing rule that a
    // failing turn is not a failing session. `failed: true` is what makes the
    // outcome speak the recovery phrase, so the caller is handed the
    // conversation back instead of hearing the agent stop. The flush comes
    // first, so speech matches the transcript already accumulated; it reads
    // `ttsText` HERE rather than through a captured reference, because the
    // coalescer is REPLACED on a poisoned-adoption restart.
    const fatalErr = fatalTool?.error();
    if (fatalErr !== undefined) {
      ttsText.flush();
      log.error("Tool failed fatally; turn stopped", {
        tool: fatalErr.toolName,
        error: fatalErr.message,
        sid,
      });
      emitError("tool", fatalErr.message, { fatal: false });
      return { messages: collected, failed: true };
    }
    // Flush buffered TTS text so speech matches the transcript already
    // accumulated via onDelta for the pre-error portion of the turn.
    ttsText.flush();
    reportLlmFailure(err, { reported: handler?.errored() === true, emitError, log, sid });
    return { messages: collected, failed: true };
  } finally {
    // The turn is over on every path (completed, aborted, errored) — no
    // dead-air filler may fire into the silence that follows it.
    handler?.dispose();
    // And no tool message may reach a coalescer this turn no longer owns. A
    // tool call that outlives its turn (one ignoring its abort signal) finds
    // the controller unbound and speaks nothing, which is the right answer.
    unbindToolSpeech();
  }
}
