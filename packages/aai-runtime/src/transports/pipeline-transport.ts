// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// A `tool.called` report is observability-only here; runtime.ts routes it to
// `client.toolCall` directly (bypassing ServerSession's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import { setMaxListeners } from "node:events";
import { normalizeSpeechText } from "@alexkroman1/aai/internal";
import { pcm16ToBytes } from "../_pcm.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createFatalToolLatch } from "../tool-error-policy.ts";
import { createContextBudget } from "./pipeline-context-budget.ts";
import { createDialogKnobs } from "./pipeline-dialog-knobs.ts";
import { createEmitError } from "./pipeline-error.ts";
import { createSpeechGate, NO_GUARDRAILS } from "./pipeline-guardrails.ts";
import { createHeardTracker } from "./pipeline-heard.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import { createTurnLlmRunner, type SharedLlmRequest } from "./pipeline-llm-stream.ts";
import { createPipelineProviderSessions } from "./pipeline-providers.ts";
import { createPipelineSpeculation } from "./pipeline-speculation.ts";
import { flushTtsAndWait } from "./pipeline-stream.ts";
import { createPipelineCommands } from "./pipeline-transport-commands.ts";
import { createPipelineLifecycle } from "./pipeline-transport-lifecycle.ts";
import {
  type PipelineTransportOptions,
  resolvePipelineOptions,
} from "./pipeline-transport-options.ts";
import { createTurnBody } from "./pipeline-turn-body.ts";
import { createTurnChain, createTurnGate, turnCrashLogger } from "./pipeline-turn-gate.ts";
import { createTurnOutcome } from "./pipeline-turn-outcome.ts";
import { createTurnMachine } from "./pipeline-turn-state.ts";
import { createUserActivity } from "./pipeline-user-speech.ts";
import { resolveSystemPrompt, type SendTtsOptions, type Transport } from "./types.ts";

/**
 * `abort` listeners one session's signal may hold before Node calls it a leak.
 *
 * A LEAK threshold, not a capacity one — see the `setMaxListeners` call below
 * for why the signal needs opting in at all and why nothing legitimate comes
 * near this. Raising it to silence a warning is the wrong move: the warning
 * fires ONCE per signal and then never again however far the count climbs, so a
 * number chosen to be quiet is a number that reports nothing.
 */
const SESSION_SIGNAL_MAX_LISTENERS = 50;

export type { PipelineTransportOptions } from "./pipeline-transport-options.ts";

/** Create a pipeline-mode Transport (STT → LLM → TTS). @internal */
export function createPipelineTransport(opts: PipelineTransportOptions): Transport {
  const {
    log,
    sttSampleRate,
    ttsSampleRate,
    maxSteps,
    minBargeInWords,
    interruptionMinDurationMs,
    deadAirCoverMs,
    heardLagMs,
    errorPhrase,
    startFailurePhrase,
    resumeFalseInterruption,
    preemptiveGeneration,
    lowConfidence,
    speechIdleTimeoutMs,
    toolChoice,
    resetToolChoice,
    toolSchemas,
    executeTool,
  } = resolvePipelineOptions(opts);
  // This session's guardrails and its token meter, both absent for the
  // overwhelming majority of agents — see `pipeline-guardrails.ts` and
  // `usage-meter.ts`.
  const guardrails = opts.guardrails ?? NO_GUARDRAILS;
  const usage = opts.usage;
  // One latch per SESSION, reset at the top of every turn: turns are serialized
  // by the turn chain, and the tool set below is built once. See
  // `tool-error-policy.ts` for why the latch's signal is not the turn's.
  const fatalTool = createFatalToolLatch();

  const { callbacks, sessionConfig } = opts;
  // The three per-STATE knobs a `dialog()` can move mid-call, over the agent's
  // own settings above. Constant thunks when no dialog declares one, so a
  // session without dialogs behaves exactly as it did — and see
  // `pipeline-dialog-knobs.ts` for why the other two a state may declare cannot
  // reach here at all.
  const knobs = createDialogKnobs(opts.dialogTurn, { minBargeInWords, interruptionMinDurationMs });
  // A THUNK, not the value: this used to capture the string here, which froze
  // the prompt for the length of the call. Every consumer below already
  // re-assembles its request per turn (`startLlmStream` is the one place a
  // `streamText` call is built), so the only thing that had to change is WHEN
  // the value is read — and a `SystemPromptOption` that is a plain string
  // resolves to itself, so a session with nothing to vary sends the same bytes
  // this line used to hand it.
  const systemPrompt = (): string => resolveSystemPrompt(sessionConfig.systemPrompt);
  // Omitting the third argument says the session is OVER — see pipeline-error.ts.
  const emitError = createEmitError(callbacks);

  const sessionAbort = new AbortController();
  // An `AbortSignal` is an EventTarget, and Node's max-listeners warning covers
  // `EventEmitter` ONLY — 12 `addEventListener("abort", …)` on a signal produce
  // no warning at all, where 11 on an emitter produce one. This signal lives for
  // the whole CALL while almost everything attaching to it is per-TURN, so it is
  // the one place in this transport where a missing `removeEventListener` would
  // accumulate silently for the length of a conversation. Opting the signal in
  // buys the same alarm the emitters get for free.
  //
  // 50 rather than the default 10 because a legitimate turn holds several at
  // once — the turn's `AbortSignal.any` composite, the speculation's, the TTS
  // drain, each provider session — and a barge-in can overlap two turns'
  // teardown. The number is a LEAK threshold, not a capacity one: nothing here
  // approaches it, so a run that reaches it is a bug rather than a busy call.
  setMaxListeners(SESSION_SIGNAL_MAX_LISTENERS, sessionAbort.signal);
  // Turn-crash handler for turnChain.chain call sites — see turnCrashLogger.
  const logTurnCrash = turnCrashLogger(log, opts.sid);
  let terminated = false;
  let nextReplyId = 0;
  // Invalidation epochs for queued turns and an aborted turn's deferred
  // persistence — see pipeline-turn-gate.ts.
  const gate = createTurnGate();
  // Turn lifecycle (the abortable in-flight reply, whether it has spoken,
  // and the TTS audio gate) — the named transitions in
  // pipeline-turn-state.ts are the only way this state changes. `spoke()`
  // is what barge-in gates on: a turn that has not spoken cannot be spoken
  // over, and aborting it would discard the reply mid-computation only to
  // restart a slower one — a user re-prompting into the silence would
  // starve the reply indefinitely.
  // It also owns the two facts that used to sit beside it here as loose `let`s
  // — the turn draining its TTS, and the turn being a false-interruption resume
  // — for the reason the module doc gives.
  const turns = createTurnMachine();
  // Pipeline transport owns its conversation memory (ServerSession does not in
  // pipeline mode): a text view (client/resume/tool-context) and a
  // ModelMessage view (what the LLM sees, incl. tool calls/results).
  const history = createPipelineHistory(sessionConfig.history);
  // Bounds what each STEP sends the model, and learns the request's fixed cost
  // (system prompt + tool declarations) from the provider's own reported usage.
  // Built once per SESSION, deliberately: neither of those changes MUCH between
  // turns (a per-turn prompt suffix moves the first of them, by the length of
  // one phase's instructions), so what one turn's last step measured is the
  // right number for the next turn's first step — the step that would otherwise be estimated blind,
  // and the only step most turns have. `undefined` for a model whose context
  // window this repo does not know, which trims nothing and leaves the session
  // on the message cap alone. It bounds the REQUEST and never `history`, which
  // the client, resume and `ctx.messages` all read. See
  // pipeline-context-budget.ts.
  const contextBudget = createContextBudget({ llm: opts.llm, log, sid: opts.sid });
  // Turn serializer + its queued-turn epoch check — see createTurnChain.
  const turnChain = createTurnChain({ gate, isTerminated: () => terminated });
  // What the caller has actually HEARD of the current reply: the barge-in
  // gate, the cut point history is truncated to, and the resume anchor, all
  // from one cursor — see createHeardTracker.
  const heard = createHeardTracker({
    sampleRate: ttsSampleRate,
    lagMs: heardLagMs,
    now: opts.heardNow,
  });

  // Everything a `streamText` request carries that a turn and a speculation
  // must AGREE on, built once and spread into both — see `SharedLlmRequest`.
  // Two assemblies meant two lists to keep in sync, and they had already
  // drifted by three fields: `maxOutputTokens`, `maxRetries` and `onUsage`
  // reached the turn and not the speculation, so an ADOPTED one ran uncapped,
  // on the vendor's default retries, and off this session's meter.
  const llmRequest: SharedLlmRequest = {
    llm: opts.llm,
    toolChoice,
    resetToolChoice,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    maxRetries: opts.maxRetries,
    onUsage: usage === undefined ? undefined : (reported) => usage.record(reported),
    dialogStep: knobs.dialogStep,
    maxSteps,
    contextBudget,
    log,
    sid: opts.sid,
  };

  // PREEMPTIVE GENERATION (OFF by default). Constructed before the speech
  // handlers because they drive it, and deliberately NOT wired into `turns` or
  // the turn chain: a speculation occupies no turn, so every barge-in gate
  // below behaves exactly as it does with the flag off. See
  // pipeline-speculation.ts.
  const speculation = createPipelineSpeculation({
    // Off whenever a dialog varies the LLM knobs: this constructor decides once,
    // from the SESSION's `toolChoice`, whether speculating is free at all — a
    // state that pins a tool would make every speculation end at the tool
    // boundary and be discarded, with the gate still believing it is free.
    enabled: preemptiveGeneration && knobs.dialogStep === undefined,
    request: llmRequest,
    toolSchemas,
    systemPrompt,
    history,
    sessionSignal: sessionAbort.signal,
    // "The floor is free": no turn running and nothing still playing out.
    isIdle: () => !(turns.inFlight() || heard.pending()),
  });

  // Nudger, recovery, speaking edges and STT handlers — see createUserActivity.
  const { nudger, recovery, speechEdges, sttEvents } = createUserActivity({
    log,
    sid: opts.sid,
    callbacks,
    silenceTimeoutMs: opts.silenceTimeoutMs,
    silencePrompt: opts.silencePrompt,
    resumeFalseInterruption,
    speculation,
    speechIdleTimeoutMs,
    minBargeInWords: knobs.minBargeInWords,
    interruptionMinDurationMs: knobs.interruptionMinDurationMs,
    lowConfidence,
    speakClarification,
    isTerminated: () => terminated,
    isSessionActive: () => !(terminated || sessionAbort.signal.aborted),
    isTurnInFlight: () => turns.inFlight(),
    isTurnDraining: () => turns.draining(),
    isResumeTurnInFlight: () => turns.resumeInFlight(),
    hasTurnSpoken: () => turns.spoke(),
    isPlaybackPending: () => heard.pending(),
    hasSpokenRecordable: () => heard.spokeRecordable(),
    abortInFlightTurn: () => abortInFlightTurn(),
    tailResumePrompt: () => heard.resumePrompt(),
    runChainedTurn,
  });

  // Provider lifecycle (open/adopt/close of the STT+TTS pair) lives in
  // pipeline-providers.ts; the (hoisted) handlers below route provider
  // events back into this turn orchestrator.
  const providers = createPipelineProviderSessions({
    sid: opts.sid,
    stt: opts.stt,
    tts: opts.tts,
    providerKeys: opts.providerKeys,
    sttSampleRate,
    ttsSampleRate,
    sttPrompt: opts.sttPrompt,
    greeting: sessionConfig.greeting,
    signal: sessionAbort.signal,
    handlers: {
      onSttPartial: sttEvents.onSttPartial,
      onSttFinal: sttEvents.onSttFinal,
      // `lifecycle` is constructed further down (it needs `outcome` and
      // `runReply`), so these two reach it lazily. Both fire only after
      // `providers.open()`, which `lifecycle.start` is what calls.
      onSttError: (err) => lifecycle.onProviderError("stt", err),
      onTtsError: (err) => lifecycle.onProviderError("tts", err),
      onTtsAudio: (pcm) => {
        if (!turns.audioGateOpen()) return;
        // The text->audio term, measured rather than inferred. It had only
        // ever been a subtraction (endpointing + `firstPartMs` against L_R at
        // the caller's ear), which put it at 0.7-1.8s; measured directly it is
        // ~66ms, so synthesis is not where a voice turn's latency lives.
        if (ttsTextAtMs !== undefined) {
          log.info("TTS first audio", { sid: opts.sid, afterTextMs: Date.now() - ttsTextAtMs });
          ttsTextAtMs = undefined;
        }
        turns.markSpoke();
        heard.onAudio(pcm);
        callbacks.onAudioChunk(pcm16ToBytes(pcm));
      },
      // Word timings ride the SAME audio gate as the audio itself, the proven
      // guard for "output from a cancelled turn must not count" — no second
      // epoch.
      onTtsWords: (words) => {
        if (!turns.audioGateOpen()) return;
        heard.onWords(words);
      },
    },
    onAudioReady: () => lifecycle.onAudioReady(),
    emitError,
    log,
  });

  // Built once per session, not per turn: per-call aborts still track the
  // owning turn because streamText forwards its own abortSignal into each
  // execute's options, which takes precedence in toVercelTools.
  const tools = toVercelTools(toolSchemas, {
    executeTool,
    sessionId: opts.sid,
    // The one thing that makes `ToolDef.onError`'s fatal arm stop a turn rather
    // than merely reject a call: the AI SDK swallows the rejection, so the
    // latch is how the in-flight request finds out.
    onFatalToolError: (error) => fatalTool.report(error),
    messages: () => history.conversation,
    // What makes a tool able to read what an earlier tool in the SAME turn
    // answered: the step's own messages only reach `llm` when the step ends,
    // and this view is the one `ctx.messages` reads.
    recordToolResult: (message) => history.pushToolResult(message),
  });

  function runChainedTurn(
    text: string,
    crashLabel: string,
    kind?: { isResume?: boolean; synthetic?: boolean },
  ): void {
    turnChain.chain(async () => {
      turns.setResumeScope(kind?.isResume === true);
      try {
        await runTurn(text, { synthetic: kind?.synthetic === true }).catch(
          logTurnCrash(crashLabel),
        );
      } finally {
        turns.setResumeScope(false);
      }
    });
  }

  /**
   * Speak one sentence on the transport's own behalf, running no model turn —
   * today only the `lowConfidence` clarification.
   *
   * Shaped like the GREETING rather than like `errorPhrase`: it goes through
   * `runReply` on the turn chain, so it holds the floor, opens the audio gate,
   * can be barged in on, and drains its TTS like any other reply. What it does
   * NOT do is touch either history view — the caller hears it and the caption
   * shows it, and the model never learns that its own replies open with
   * apologies (the rule `AgentTranscriptRecovery` states; `low-confidence` is
   * the third member of that enum for exactly this).
   */
  function speakClarification(text: string): void {
    turnChain.chain(() =>
      runReply("pipeline-clarify", async () => {
        callbacks.report({
          type: "agent-transcript.committed",
          text,
          recovery: "low-confidence",
        });
        sendTtsText(text, { publishTranscript: false });
        return true;
      }).catch(logTurnCrash("Pipeline clarification failed")),
    );
  }

  /** Abort the in-flight turn (if any) and cancel TTS playback. */
  function abortInFlightTurn(): void {
    // FIRST: latch where the caller's ear had got to, before anything resets
    // the playback clock that position is read from. The persistence below runs
    // when the aborted stream settles, long after this — see HeardTracker.cut.
    heard.cut();
    turns.interrupt();
    providers.tts?.cancel();
  }

  /** Forward turn text to TTS, reopening the audio gate for the new turn.
   * Publishing here rather than at reply end keeps captions with the audio — a
   * tool chain speaks filler long before the answer exists. `publishTranscript:
   * false` skips it for the greeting/start-failure lines, which publish their own
   * final. The tail advances either way: it feeds the tail-resume estimate. */
  /**
   * When this turn's FIRST text went to TTS, for the `TTS first audio`
   * measurement above. Cleared as soon as that turn's audio arrives, so a reply
   * streamed as several sentences is timed from its first one rather than its
   * latest.
   */
  let ttsTextAtMs: number | undefined;

  function sendTtsTextNow(text: string, opts?: SendTtsOptions): void {
    turns.openAudioGate();
    ttsTextAtMs ??= Date.now();
    // ASCII-fold typographic quotes for the engine; length-preserving, so the
    // heard cursor below still indexes the same positions (normalizeSpeechText).
    providers.tts?.sendText(normalizeSpeechText(text));
    const tail = heard.onText(text, opts?.record !== false);
    if (opts?.publishTranscript !== false)
      callbacks.report({ type: "agent-transcript.updated", text: tail });
  }

  /**
   * The funnel every collaborator below is handed — the raw send when this
   * session declares no output guardrail, and a HOLDABLE wrapper around it when
   * it does. Wrapping here rather than at each call site is what makes "one
   * place all speech goes through" true of the hold as well as of the send.
   */
  const speech = createSpeechGate(guardrails.holdsSpeech, sendTtsTextNow);
  const sendTtsText = speech.send;

  // How a turn is wrapped up once its stream settles — interrupted, failed, or
  // spoken. See pipeline-turn-outcome.ts.
  const outcome = createTurnOutcome({
    history,
    callbacks,
    providers,
    gate,
    errorPhrase,
    startFailurePhrase,
    sendTtsText,
    drainTts: () => drainTts(sessionAbort.signal),
    dialogKeyterms: knobs.keyterms,
  });

  const consumeLlmStream = createTurnLlmRunner({
    ...llmRequest,
    systemPrompt,
    messages: history.llm,
    tools,
    fatalTool,
    deadAirCoverMs,
    // An open speech edge means an utterance is in progress (0 when not).
    callerSpeaking: () => speechEdges.durationMs() > 0,
    sendTtsText,
    callbacks,
    emitError,
    log,
    sid: opts.sid,
  });

  /** Per-turn TTS drain — see flushTtsAndWait in pipeline-stream.ts. */
  function drainTts(signal: AbortSignal): Promise<void> {
    return flushTtsAndWait({ tts: providers.tts, signal, log, sid: opts.sid, emitError });
  }

  /**
   * Shared reply scaffold: mint the reply id and turn controller, run the
   * turn body, then drain TTS — only when the body produced speech, since a
   * tool-call-only turn never gets a TTS `done` and would burn the full
   * flush timeout. Do NOT report `audio.completed` here — session-core's
   * flushReply emits audioDone + replyDone together; calling it here would
   * double-fire audio_done.
   */
  async function runReply(
    idPrefix: string,
    body: (signal: AbortSignal) => Promise<boolean /* spoke */>,
  ): Promise<void> {
    // A turn is taking the floor: whatever speculation is still standing was
    // not claimed by it (`runTurn` claims BEFORE calling in), so it belongs to
    // an utterance this turn has moved past. Discarded here rather than left to
    // be adopted later by a turn that never spoke the words it was built on.
    speculation.discard("turn-started");
    callbacks.onReplyStarted(`${idPrefix}-${++nextReplyId}`);

    const ctl = new AbortController();
    // stop()/terminate() aborts only the turn of the moment; combine with
    // the session signal so a turn that starts later still dies with the
    // session instead of running against closed providers. AbortSignal.any
    // holds its sources weakly, so a settled turn leaves no listener on the
    // session-lifetime signal.
    const signal = AbortSignal.any([sessionAbort.signal, ctl.signal]);
    turns.begin(ctl);
    heard.startReply();

    try {
      const spoke = await body(signal);
      if (spoke && !signal.aborted) {
        // The body persisted the full reply; only synthesis/playback remains.
        // A barge-in in this window is classified as a playback cut (see
        // TurnMachine.draining).
        turns.setDraining(true);
        try {
          await drainTts(signal);
        } finally {
          turns.setDraining(false);
        }
      }
      if (!signal.aborted) callbacks.report({ type: "reply.completed" });
    } finally {
      // Return to idle unless a newer turn already replaced this one.
      turns.settle(ctl);
      // Aborted turns skip the re-arm: onSttPartial / cancelReply handle those.
      if (!signal.aborted) nudger.arm();
    }
  }

  // The ordinary turn body (user message → LLM stream → outcome) — see
  // createTurnBody. Declared after `runReply` because it wraps it.
  const runTurn = createTurnBody({
    gate,
    history,
    heard,
    outcome,
    consumeLlmStream,
    speculation,
    runReply,
    guardrails,
    speech,
    fatalTool,
    usage,
    sendTtsText,
    emitError,
  });

  // Session lifecycle: open/greet/teardown — see
  // pipeline-transport-lifecycle.ts. Built last because it wraps `runReply`
  // and `outcome`; `providers` reaches back into it through the two lazy
  // handlers above.
  const lifecycle = createPipelineLifecycle({
    sid: opts.sid,
    log,
    callbacks,
    emitError,
    sessionAbort,
    greeting: sessionConfig.greeting,
    skipGreeting: opts.skipGreeting,
    gate,
    turns,
    turnChain,
    history,
    outcome,
    speculation,
    nudger,
    recovery,
    speechEdges,
    providers: () => providers,
    isTerminated: () => terminated,
    markTerminated: () => {
      terminated = true;
    },
    abortInFlightTurn,
    sendTtsText,
    runReply,
    logTurnCrash,
  });

  return createPipelineCommands({
    lifecycle,
    providers: () => providers,
    history,
    heard,
    gate,
    recovery,
    speechEdges,
    nudger,
    speculation,
    abortInFlightTurn,
    runChainedTurn,
    isTerminated: () => terminated,
  });
}
