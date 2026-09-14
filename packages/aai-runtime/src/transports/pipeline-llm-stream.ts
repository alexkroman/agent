// Copyright 2026 the AAI authors. MIT license.
// One `streamText` turn: assembling the request, consuming its `fullStream`
// through the shared part handler, and collecting the step messages history
// needs.
//
// Split out of `pipeline-stream.ts` (which keeps the TTS-side plumbing —
// coalescing, flush-wait, the playback message conversion) so that this module
// can hold BOTH the ordinary path and the preemptive-generation path without
// either file passing the length cap.
//
// The split is load-bearing for preemption's correctness, not just for line
// count: `startLlmStream` is the ONE place a `streamText` request is assembled,
// and the speculative launcher calls it with a different tool set and nothing
// else different. That is what makes adopting a speculative stream into a real
// turn legitimate — see `pipeline-speculation.ts`.

import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { type ModelMessage, stepCountIs, streamText } from "ai";
import {
  composePrepareStep,
  forceFinalAnswer,
  resetToolChoiceAfterFirstStep,
} from "../_prepare-step.ts";
import { createToolCallRepair } from "../tool-call-repair.ts";
import { withFatalSignal } from "../tool-error-policy.ts";
import { drainEntries, partsAsEntries } from "./pipeline-llm-drain.ts";
import { bindToolSpeech, stepMessages } from "./pipeline-llm-tool-speech.ts";
import { createTurnTrace } from "./pipeline-llm-trace.ts";
import type {
  AdoptedLlmStream,
  ConsumeLlmStreamParams,
  LlmRequest,
  LlmStreamResult,
  StartedLlmStream,
  StepResult,
  TapeEntry,
} from "./pipeline-llm-types.ts";
import { smoothTextStream } from "./pipeline-smooth.ts";
import { createTtsTextCoalescer } from "./pipeline-stream.ts";
import {
  createStreamPartHandler,
  llmErrorDetails,
  llmErrorSentence,
  type StreamPart,
  type StreamPartHandler,
} from "./pipeline-stream-parts.ts";
import { resolveSystemPrompt } from "./types.ts";

/**
 * Every TYPE this module's two functions speak — the request parameters, the
 * turn result, the adopted-speculation handover and its tape — lives in
 * `pipeline-llm-types.ts`, split off when this file passed the source-length
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
} from "./pipeline-llm-types.ts";

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
 * — see the request-parity spec in `pipeline-llm-stream.test.ts`.
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
    // ONE slot, FOUR things to say — see `_prepare-step.ts`. Last writer wins
    // per key, so the ORDER is `ToolChoice`'s documented scope precedence
    // (agent → turn → dialog state → forced final step) written out:
    //
    // 1. the context budget, which owns `messages` and shares no key with the
    //    three below;
    // 2. the AGENT-scoped reset, which puts a demanding `toolChoice` back to
    //    `"auto"` after step 0;
    // 3. the DIALOG STATE's knobs, which beat the agent's for exactly as long
    //    as the conversation is in that state — so this must come AFTER the
    //    reset. It used to come before, and the reset then overwrote a state's
    //    pin with `"auto"` from step 1 on: a state that must call a tool (or
    //    must not) silently stopped meaning it after the first step of every
    //    turn, on every agent whose own `toolChoice` demands something;
    // 4. `forceFinalAnswer`, which owns the same key on the one step the budget
    //    reserved and must win there over all three.
    //
    // Writing any of them straight into the slot deletes the others, silently.
    prepareStep: composePrepareStep(
      req.contextBudget,
      resetToolChoiceAfterFirstStep(req.toolChoice, req.resetToolChoice ?? true),
      req.dialogStep,
      forceFinalAnswer(req.maxSteps, req.log, req.sid),
    ),
    abortSignal: req.signal,
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
      repairToolCall: createToolCallRepair(deps.llm, deps.log, () => signal),
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
    coalescer: () => ttsText,
    onDelta,
    callerSpeaking,
  });
  // Hoisted rather than written at the handler below, where the conditional
  // costs this function a cognitive-complexity point it does not have. It is
  // OMITTED rather than answering `false` for a caller with no controller, so
  // a tool-less turn's dead-air cover is byte-identical to what it was.
  const toolCovering = toolSpeech === undefined ? undefined : () => toolSpeech.covering();
  // Response messages of completed steps — on the adopted path this module owns
  // the copy, since the speculation's own `collected` is behind the tape.
  const collected: ModelMessage[] = [];
  try {
    // At most two passes: the adopted tape, then — if that tape turns out to
    // hold a tool call — one fresh run with the real, executable tools.
    let useAdopted = adopted;
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
        // Lets the dead-air cover die with the turn: a barge-in during a tool
        // execution parks the fullStream read, deferring dispose() below.
        signal,
        callerSpeaking,
        // Vapi's "idle messages are disabled during tool calls", in this
        // repo's vocabulary: a tool that declares its own start or delay lines
        // is already covering the gap, so the generic cover stands down rather
        // than speaking a second sentence about one silence.
        toolCovering,
        // `pipeline-stream-parts.ts` keeps its own two parameters: it is transport
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
      const trace = createTurnTrace({ log, sid, adopted: useAdopted !== undefined });
      const { lateToolCall, spokeBeforeRestart } = await drainEntries(entries, handler, {
        adopted: useAdopted !== undefined,
        signal,
        collected,
        onStepPersisted,
        trace,
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
      const settled = await steps;
      return {
        messages: stepMessages(settled, toolSpeech),
        // A stream can end without throwing having emitted nothing but an `error`
        // part, which is still a turn the caller never heard a reply to.
        failed: handler.errored(),
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
    const msg = llmErrorSentence(err);
    log.error("LLM streamText failed", { error: msg, sid, ...llmErrorDetails(err) });
    // ONE failure, reported ONCE — the part-level report already named the cause
    // and this throw does not; {@link llmErrorSentence} carries the argument.
    // NON-fatal: this turn is over, the session is not. The caller returns
    // `failed: true`, which speaks `errorPhrase` — "Sorry, I had a problem just
    // then. Could you say that again?" — so reporting the session dead here asked
    // the user to repeat themselves into a released microphone.
    if (handler?.errored() !== true) emitError("llm", msg, { fatal: false });
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
