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

import type { ToolChoice } from "@alexkroman1/aai";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type Tool,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { composePrepareStep, forceFinalAnswer } from "../_prepare-step.ts";
import type { Logger } from "../runtime-config.ts";
import { createToolCallRepair } from "../tool-call-repair.ts";
import type { ContextBudgetPreparer } from "./pipeline-context-budget.ts";
import { drainEntries, partsAsEntries } from "./pipeline-llm-drain.ts";
import { createTurnTrace } from "./pipeline-llm-trace.ts";
import { smoothTextStream } from "./pipeline-smooth.ts";
import { createTtsTextCoalescer } from "./pipeline-stream.ts";
import {
  createStreamPartHandler,
  llmErrorDetails,
  type StreamPart,
  type StreamPartHandler,
} from "./pipeline-stream-parts.ts";
import type { EmitError, SendTtsText, TransportCallbacks } from "./types.ts";

/** Parameters for {@link consumeLlmStream}, threading session state explicitly. */
export interface ConsumeLlmStreamParams {
  /** LLM provider (Vercel AI SDK LanguageModel). */
  llm: LanguageModel;
  /** System prompt for the turn. */
  systemPrompt: string;
  /** Conversation history in Vercel AI SDK ModelMessage form. */
  messages: ModelMessage[];
  /** Tool set bound to the transport's executeTool. */
  tools: Record<string, Tool>;
  /** Tool selection policy passed to `streamText`. */
  toolChoice: ToolChoice;
  /** LLM sampling temperature; omitted entirely from streamText when unset. */
  temperature: number | undefined;
  /** Repairs malformed tool-call arguments by re-asking the model. */
  repairToolCall: ToolCallRepairFunction<ToolSet>;
  /** Max LLM tool-call steps for this turn. */
  maxSteps: number;
  /**
   * Bounds what each step SENDS to the model — see `pipeline-context-budget.ts`.
   *
   * A `prepareStep` preparer, composed with `forceFinalAnswer` rather than
   * replacing it (`composePrepareStep`), and `undefined` when the model's
   * context window is not known, at which point nothing is trimmed. It is
   * SESSION-scoped: the fixed cost it learns from one step's reported usage is
   * the right number for the next turn's first step.
   */
  contextBudget?: ContextBudgetPreparer | undefined;
  /**
   * Forwards text to the active TTS session (no-op if none). `record: false`
   * marks dead-air filler: audible, but never part of the record.
   */
  sendTtsText: SendTtsText;
  /** Dead-air cover window (ms); 0 disables — see {@link StreamPartHandlerDeps}. */
  deadAirCoverMs?: number | undefined;
  /** Is the caller speaking right now? Suppresses filler — see StreamPartHandlerDeps. */
  callerSpeaking?: (() => boolean) | undefined;
  /** Tool-call/tool-result observability hooks, forwarded to SessionCore. */
  callbacks: Pick<TransportCallbacks, "report">;
  /** Report an LLM-stream error. */
  emitError: EmitError;
  log: Logger;
  sid: string;
  /** The turn's abort signal (turn cancellation / barge-in / session end). */
  signal: AbortSignal;
  /** Receives each assistant text delta (accumulated into the transcript). */
  onDelta: (delta: string) => void;
  /**
   * Fires after each completed LLM step, once that step's response messages
   * are safe in the collected history. The transport uses it to snapshot how
   * much of the accumulated transcript is already persisted, so an aborted
   * turn's `[interrupted]` marker carries only the unpersisted tail.
   */
  onStepPersisted?: (() => void) | undefined;
  /**
   * The adopted run was abandoned and the turn is starting from the top. This
   * module resets its own copies; `onDelta` has been appending to a string the
   * CALLER owns, and left standing the abandoned preamble sits in front of the
   * restarted text and is committed to history twice. See the late-poison
   * restart in {@link consumeLlmStream}.
   */
  onRestart?: (() => void) | undefined;
  /**
   * A speculative stream, already running against this exact request, to drain
   * instead of launching a new one — see `pipeline-speculation.ts`. Present
   * only when the committed user text matched what the speculation was started
   * from, so the request the caller would have assembled is the request already
   * in flight.
   */
  adopted?: AdoptedLlmStream | undefined;
}

/** Outcome of one {@link consumeLlmStream} turn. */
export interface LlmStreamResult {
  /**
   * Response messages of every step that COMPLETED, for history.
   *
   * On abort or stream error this holds the steps finished before the
   * interruption (tool calls with their results) — never `undefined` — so
   * barge-in does not erase work already done: the next turn's LLM still sees
   * which tools ran and what they returned. An in-flight step is dropped whole
   * (no dangling tool call without its result).
   */
  messages: ModelMessage[];
  /**
   * The stream errored out rather than completing or being aborted.
   *
   * The caller needs this to speak a recovery phrase: a failed turn usually
   * produces no text at all, so nothing reaches TTS and the caller hears
   * silence. An empty `messages` array cannot express it — a successful turn
   * that produced no tool steps looks identical. A deliberate barge-in is NOT
   * a failure; it has its own recovery path.
   */
  failed: boolean;
}

/** One completed `streamText` step, narrowed to the part history needs. */
export interface StepResult {
  response: { messages: ModelMessage[] };
}

/**
 * A speculative stream handed over to the real turn that adopted it.
 *
 * `entries()` replays what the speculation already drained and then FOLLOWS the
 * same live run — one continuous sequence, which is why preemption is a head
 * START rather than a cache lookup. See `pipeline-speculative-stream.ts` for why
 * the speculation stays the sole reader of the underlying stream.
 */
export interface AdoptedLlmStream {
  /** Taped entries then live ones, in arrival order, ending when the run does. */
  entries(): AsyncIterable<TapeEntry>;
  /** `result.steps`, for the same final gather the ordinary path does. */
  steps(): Promise<readonly StepResult[]>;
  /**
   * Abandon the adopted run WITHOUT aborting the turn that adopted it.
   *
   * `adopt()` re-parents the speculation onto the turn's signal, so by this
   * point aborting the turn is the only other way to stop the request — and the
   * turn is precisely what must survive. See the late-poison restart in
   * {@link consumeLlmStream}.
   */
  abandon(): void;
}

/**
 * One entry of a speculation's tape. `step` markers keep `onStepPersisted`
 * ordering exact on replay: the transport snapshots how much text a completed
 * step covers, and taping only the parts would put that snapshot in the wrong
 * place.
 */
export type TapeEntry =
  | { readonly kind: "part"; readonly part: StreamPart }
  | { readonly kind: "step"; readonly messages: readonly ModelMessage[] };

/** What {@link startLlmStream} hands back to whoever drains it. */
export interface StartedLlmStream {
  /** Parts as `streamText` produces them. */
  fullStream: AsyncIterable<StreamPart>;
  /** Settles with every step of the turn, after the stream ends. */
  steps: Promise<readonly StepResult[]>;
  /** Response messages of steps that COMPLETED, pushed as they finish. */
  collected: ModelMessage[];
}

/** The request half of {@link ConsumeLlmStreamParams} — see {@link startLlmStream}. */
export type LlmRequest = Pick<
  ConsumeLlmStreamParams,
  | "llm"
  | "systemPrompt"
  | "messages"
  | "tools"
  | "toolChoice"
  | "temperature"
  | "repairToolCall"
  | "maxSteps"
  | "contextBudget"
  | "log"
  | "sid"
  | "signal"
> & { onStep?: ((messages: readonly ModelMessage[]) => void) | undefined };

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
  // Response messages of completed steps, collected incrementally so an
  // aborted turn still returns everything that finished before the abort.
  const collected: ModelMessage[] = [];
  const result = streamText({
    model: req.llm,
    system: req.systemPrompt,
    messages: req.messages,
    tools: req.tools,
    toolChoice: req.toolChoice,
    // Temperature only when set — Claude 5 ignores it and warns.
    ...omitUndefined({ temperature: req.temperature }),
    // Word-coalesce text for TTS, keeping thinking signatures (see pipeline-smooth.ts).
    experimental_transform: smoothTextStream(),
    experimental_repairToolCall: req.repairToolCall,
    // `maxSteps` bounds TOOL-CALLING steps; the budget is one larger so the
    // forced answer step below has somewhere to run. See forceFinalAnswer.
    stopWhen: stepCountIs(req.maxSteps + 1),
    // ONE slot, TWO things to say — see `_prepare-step.ts`. The budget decides
    // which messages this step may send and must keep them; `forceFinalAnswer`
    // goes last and wins on `toolChoice`, the one key it sets. Writing either
    // straight into the slot deletes the other, silently.
    prepareStep: composePrepareStep(
      req.contextBudget,
      forceFinalAnswer(req.maxSteps, req.log, req.sid),
    ),
    abortSignal: req.signal,
    onStepFinish: (step) => {
      collected.push(...step.response.messages);
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
    collected,
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
  } = params;
  // Batch word-granularity deltas into fewer TTS provider sends; the
  // transcript path (onDelta) keeps full delta granularity.
  let ttsText = createTtsTextCoalescer(sendTtsText);
  let handler: StreamPartHandler | undefined;
  // Response messages of completed steps — on the adopted path this module owns
  // the copy, since the speculation's own `collected` is behind the tape.
  const collected: ModelMessage[] = [];
  try {
    // At most two passes: the adopted tape, then — if that tape turns out to
    // hold a tool call — one fresh run with the real, executable tools.
    let useAdopted = adopted;
    for (;;) {
      let entries: AsyncIterable<TapeEntry>;
      let steps: Promise<readonly StepResult[]>;
      if (useAdopted) {
        entries = useAdopted.entries();
        steps = useAdopted.steps();
      } else {
        const started = startLlmStream({
          ...params,
          onStep: (messages) => {
            collected.push(...messages);
            onStepPersisted?.();
          },
        });
        entries = partsAsEntries(started.fullStream);
        steps = started.steps;
      }
      handler = createStreamPartHandler({
        onDelta,
        sendTtsText: ttsText.send,
        onTtsBoundary: ttsText.boundary,
        deadAirCoverMs,
        // Lets the dead-air cover die with the turn: a barge-in during a tool
        // execution parks the fullStream read, deferring dispose() below.
        signal,
        callerSpeaking,
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
        messages: settled.flatMap((step) => step.response.messages),
        // A stream can end without throwing having emitted nothing but an `error`
        // part, which is still a turn the caller never heard a reply to.
        failed: handler.errored(),
      };
    }
  } catch (err: unknown) {
    // A barge-in is not a failure — it has its own recovery path, and an
    // apology on top of a deliberate interruption would be wrong.
    if (signal.aborted) return { messages: collected, failed: false };
    // Flush buffered TTS text so speech matches the transcript already
    // accumulated via onDelta for the pre-error portion of the turn.
    ttsText.flush();
    const msg = errorMessage(err);
    log.error("LLM streamText failed", { error: msg, sid, ...llmErrorDetails(err) });
    // NON-fatal: this turn is over, the session is not. The caller returns
    // `failed: true`, which speaks `errorPhrase` — "Sorry, I had a problem just
    // then. Could you say that again?" — so reporting the session dead here asked
    // the user to repeat themselves into a released microphone.
    emitError("llm", msg, { fatal: false });
    return { messages: collected, failed: true };
  } finally {
    // The turn is over on every path (completed, aborted, errored) — no
    // dead-air filler may fire into the silence that follows it.
    handler?.dispose();
  }
}
