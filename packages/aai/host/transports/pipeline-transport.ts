// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// `callbacks.onToolCall` is observability-only; runtime.ts routes it to
// `client.toolCall` directly (bypassing SessionCore's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import type { SttError, TtsError } from "../../sdk/providers.ts";
import type { Message } from "../../sdk/types.ts";
import { bytesToPcm16, pcm16ToBytes } from "../_pcm.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createEmitError } from "./pipeline-error.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import { createPipelineProviderSessions } from "./pipeline-providers.ts";
import { createReplyTailTracker } from "./pipeline-recovery.ts";
import { createToolCallRepair } from "./pipeline-repair.ts";
import {
  createPlaybackClock,
  flushTtsAndWait,
  type LlmStreamResult,
  consumeLlmStream as runLlmStream,
} from "./pipeline-stream.ts";
import {
  type PipelineTransportOptions,
  resolvePipelineOptions,
} from "./pipeline-transport-options.ts";
import { createTurnGate, turnCrashLogger } from "./pipeline-turn-gate.ts";
import { createTurnOutcome } from "./pipeline-turn-outcome.ts";
import { createTurnMachine } from "./pipeline-turn-state.ts";
import { createUserActivity } from "./pipeline-user-speech.ts";
import type { Transport } from "./types.ts";

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
    holdPhrase,
    errorPhrase,
    startFailurePhrase,
    falseInterruptionTimeoutMs,
    toolChoice,
    toolSchemas,
    executeTool,
  } = resolvePipelineOptions(opts);

  const { callbacks, sessionConfig } = opts;
  const systemPrompt = sessionConfig.systemPrompt;
  // Omitting the third argument says the session is OVER — see pipeline-error.ts.
  const emitError = createEmitError(callbacks);

  const sessionAbort = new AbortController();
  // Turn-crash handler for chainTurn call sites — see turnCrashLogger.
  const logTurnCrash = turnCrashLogger(log, opts.sid);
  let audioReady = false;
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
  const turns = createTurnMachine();
  // The in-flight turn's body has completed (full text persisted, no
  // [interrupted] marker) and only the TTS drain remains — a barge-in in this
  // window is a playback cut, so its false-interruption recovery must use the
  // cut-point prompt, not [interrupted]. Written only by runReply's drain.
  let turnDraining = false;
  // The running chained turn is a false-interruption resume; a committed user
  // turn moots an unspoken one (see onSttFinal in pipeline-user-speech.ts).
  // Written only by runChainedTurn.
  let resumeTurnScope = false;
  // Pipeline transport owns its conversation memory (SessionCore does not in
  // pipeline mode): a text view (client/resume/tool-context) and a
  // ModelMessage view (what the LLM sees, incl. tool calls/results).
  const history = createPipelineHistory(sessionConfig.history);
  let turnPromise: Promise<void> | null = null;
  // The in-flight providers.open() from start(). stop() awaits it so a
  // disconnect mid-connect tears the just-opened provider sockets down
  // deterministically instead of leaving fire-and-forget opens to pile up.
  let startPromise: Promise<"ok" | "failed"> | null = null;
  // Tracks when the client is estimated to finish playing forwarded TTS audio,
  // so barge-in keeps working after the server-side turn is done but buffered
  // audio is still playing client-side (see createPlaybackClock).
  const playbackClock = createPlaybackClock(ttsSampleRate);
  // What the current reply handed to TTS (cumulative transcript + audio
  // duration), which is also where a playback-tail barge-in's cut point comes
  // from — see createReplyTailTracker.
  const replyTail = createReplyTailTracker({
    sampleRate: ttsSampleRate,
    remainingMs: () => playbackClock.remainingMs(),
  });

  // Silence nudger, false-interruption recovery, speaking edges and the STT
  // handlers that drive them — see createUserActivity.
  const { nudger, recovery, speechEdges, sttEvents } = createUserActivity({
    log,
    sid: opts.sid,
    callbacks,
    silenceTimeoutMs: opts.silenceTimeoutMs,
    silencePrompt: opts.silencePrompt,
    falseInterruptionTimeoutMs,
    minBargeInWords,
    interruptionMinDurationMs,
    isTerminated: () => terminated,
    isSessionActive: () => !(terminated || sessionAbort.signal.aborted),
    isTurnInFlight: () => turns.inFlight(),
    isTurnDraining: () => turnDraining,
    isResumeTurnInFlight: () => resumeTurnScope && turns.inFlight(),
    hasTurnSpoken: () => turns.spoke(),
    isPlaybackPending: () => playbackClock.pending(),
    abortInFlightTurn: () => abortInFlightTurn(),
    tailResumePrompt: () => replyTail.resumePrompt(),
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
      onSttError: (err) => onProviderError("stt", err),
      onTtsError: (err) => onProviderError("tts", err),
      onTtsAudio: (pcm) => {
        if (!turns.audioGateOpen()) return;
        turns.markSpoke();
        replyTail.onAudio(pcm);
        playbackClock.onChunk(pcm);
        callbacks.onAudioChunk(pcm16ToBytes(pcm));
      },
    },
    onAudioReady,
    emitError,
    log,
  });

  // Built once per session, not per turn: per-call aborts still track the
  // owning turn because streamText forwards its own abortSignal into each
  // execute's options, which takes precedence in toVercelTools.
  const tools = toVercelTools(toolSchemas, {
    executeTool,
    sessionId: opts.sid,
    messages: () => history.conversation,
  });

  function chainTurn(start: () => Promise<void>): void {
    // Captured at enqueue, re-checked at run: a reset/stop/cancelReply landing
    // while this turn waits behind an active one strands it — otherwise it
    // would run a full billed streamText turn after the session moved on.
    const epoch = gate.queueEpoch();
    // Chain past a rejected predecessor: every call site attaches its own
    // .catch, but one that slips through must cost that turn, not wedge the
    // serializer (a rejected turnPromise would mean no turn ever runs again).
    turnPromise = (turnPromise ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => (terminated || !gate.queueCurrent(epoch) ? undefined : start()));
  }

  function runChainedTurn(text: string, crashLabel: string, kind?: { isResume: boolean }): void {
    chainTurn(async () => {
      resumeTurnScope = kind?.isResume === true;
      try {
        await runTurn(text).catch(logTurnCrash(crashLabel));
      } finally {
        resumeTurnScope = false;
      }
    });
  }

  /** Abort the in-flight turn (if any) and cancel TTS playback. */
  function abortInFlightTurn(): void {
    turns.interrupt();
    providers.tts?.cancel();
    // Every abort path ends with the client flushing its playback buffer
    // (`cancelled` for barge-in/client cancel, `reset` for reset, teardown
    // for terminate), so the estimated-playback clock restarts from zero.
    playbackClock.reset();
  }

  // Idempotent teardown after an unrecoverable provider error.
  function terminate(): void {
    if (terminated) return;
    terminated = true;
    gate.invalidateAll();
    nudger.clear();
    recovery.clear();
    speechEdges.reset();
    abortInFlightTurn();
    callbacks.onCancelled();
    sessionAbort.abort();
    // Close whatever was adopted before the failure (e.g. TTS went live,
    // then STT's open failed) — it must not outlive the terminate.
    providers.close().catch(() => {
      // Best-effort teardown; a failed close is not actionable here.
    });
  }

  /** Either provider failing is unrecoverable: surface it and tear the session down. */
  function onProviderError(kind: "stt" | "tts", err: SttError | TtsError): void {
    if (terminated) return;
    log.error(`${kind.toUpperCase()} error`, {
      code: err.code,
      message: err.message,
      sid: opts.sid,
    });
    emitError(kind, err.message);
    terminate();
  }

  /** Forward turn text to TTS, reopening the audio gate for the new turn.
   * Publishing here rather than at reply end keeps captions with the audio — a
   * tool chain speaks filler long before the answer exists. `publishTranscript:
   * false` skips it for the greeting/start-failure lines, which publish their own
   * final. The tail advances either way: it feeds the tail-resume estimate. */
  function sendTtsText(text: string, opts?: { publishTranscript?: boolean }): void {
    turns.openAudioGate();
    providers.tts?.sendText(text);
    const tail = replyTail.onText(text);
    if (opts?.publishTranscript !== false) callbacks.onAgentTranscriptPartial?.(tail);
  }

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
  });

  const consumeLlmStream = (
    signal: AbortSignal,
    onDelta: (delta: string) => void,
    onStepPersisted?: () => void,
  ): Promise<LlmStreamResult> =>
    runLlmStream({
      llm: opts.llm,
      systemPrompt,
      messages: history.llm,
      tools,
      toolChoice,
      temperature: opts.temperature,
      // Built per turn so the repair holds THIS turn's signal. Reading the
      // mutable turn state at repair time raced barge-in: settled, the
      // repair ran unsignalled (an orphaned billed call); replaced, it held
      // the NEXT turn's signal.
      repairToolCall: createToolCallRepair(opts.llm, log, () => signal),
      maxSteps,
      holdPhrase,
      // An open speech edge means an utterance is in progress (0 when not).
      callerSpeaking: () => speechEdges.durationMs() > 0,
      sendTtsText,
      callbacks,
      emitError,
      log,
      sid: opts.sid,
      signal,
      onDelta,
      onStepPersisted,
    });

  /** Per-turn TTS drain — see flushTtsAndWait in pipeline-stream.ts. */
  function drainTts(signal: AbortSignal): Promise<void> {
    return flushTtsAndWait({ tts: providers.tts, signal, log, sid: opts.sid, emitError });
  }

  /**
   * Shared reply scaffold: mint the reply id and turn controller, run the
   * turn body, then drain TTS — only when the body produced speech, since a
   * tool-call-only turn never gets a TTS `done` and would burn the full
   * flush timeout. Do NOT call callbacks.onAudioDone() here — session-core's
   * flushReply emits audioDone + replyDone together; calling it here would
   * double-fire audio_done.
   */
  async function runReply(
    idPrefix: string,
    body: (signal: AbortSignal) => Promise<boolean /* spoke */>,
  ): Promise<void> {
    callbacks.onReplyStarted(`${idPrefix}-${++nextReplyId}`);

    const ctl = new AbortController();
    // stop()/terminate() aborts only the turn of the moment; combine with
    // the session signal so a turn that starts later still dies with the
    // session instead of running against closed providers. AbortSignal.any
    // holds its sources weakly, so a settled turn leaves no listener on the
    // session-lifetime signal.
    const signal = AbortSignal.any([sessionAbort.signal, ctl.signal]);
    turns.begin(ctl);
    replyTail.reset();

    try {
      const spoke = await body(signal);
      if (spoke && !signal.aborted) {
        // The body persisted the full reply; only synthesis/playback remains.
        // A barge-in in this window is classified as a playback cut (see
        // turnDraining above).
        turnDraining = true;
        try {
          await drainTts(signal);
        } finally {
          turnDraining = false;
        }
      }
      if (!signal.aborted) callbacks.onReplyDone();
    } finally {
      // Return to idle unless a newer turn already replaced this one.
      turns.settle(ctl);
      // Aborted turns skip the re-arm: onSttPartial / cancelReply handle those.
      if (!signal.aborted) nudger.arm();
    }
  }

  function runTurn(userText: string): Promise<void> {
    return runReply("pipeline", async (signal) => {
      // reset() bumps this before clearing history — the persistence below
      // runs asynchronously after the abort and must not write the
      // interrupted tail into (or emit a transcript over) a fresh conversation.
      const historyEpoch = gate.historyEpoch();
      history.pushConversation({ role: "user", content: userText });
      history.pushLlm({ role: "user", content: userText });

      let accumulated = "";
      // Portion of `accumulated` already inside persisted step messages.
      let persistedLen = 0;
      const onDelta = (delta: string): void => {
        accumulated += delta;
      };
      const { messages: responseMessages, failed } = await consumeLlmStream(signal, onDelta, () => {
        persistedLen = accumulated.length;
      });

      if (signal.aborted) {
        outcome.persistBargeIn({
          historyEpoch,
          accumulated,
          persistedLen,
          stepMessages: responseMessages,
        });
        return false;
      }

      // Persist the assistant tool-call message(s) and their `tool` results so
      // the next turn retains tool context, not just the spoken transcript.
      if (responseMessages.length > 0) history.pushLlm(...responseMessages);

      if (outcome.speakRecovery(failed)) return true;

      if (accumulated.length === 0) return false;
      outcome.finishSpokenTurn(accumulated);
      return true;
    });
  }

  function runGreeting(text: string): Promise<void> {
    return runReply("pipeline-greeting", async () => {
      callbacks.onAgentTranscript(text, false);
      history.pushConversation({ role: "assistant", content: text });
      history.pushLlm({ role: "assistant", content: text });
      sendTtsText(text, { publishTranscript: false });
      // Push the greeting mid-stream too (it was already seeded at STT connect
      // time) — covers providers that only support the mid-stream hook.
      providers.stt?.updateAgentContext?.(text);
      return true;
    });
  }

  function onAudioReady(): void {
    if (audioReady || terminated) return;
    audioReady = true;
    if (opts.skipGreeting) return;
    const greeting = sessionConfig.greeting;
    if (!greeting) return;
    chainTurn(() => runGreeting(greeting).catch(logTurnCrash("Pipeline greeting failed")));
  }

  return {
    async start(): Promise<void> {
      // STT and TTS open concurrently; a failed side (with the session still
      // live) tears the whole transport down.
      startPromise = providers.open();
      if ((await startPromise) === "failed") {
        // The greeting turn may already be running (onAudioReady fires the
        // moment TTS is adopted, before open() settles). Silence it — strand
        // the queued copy and abort a running one — so the failure phrase is
        // the sole speaker instead of interleaving with the greeting and
        // racing its TTS drain.
        gate.invalidateQueued();
        abortInFlightTurn();
        // Say something first, while the socket is still up and TTS may still
        // be live — see speakStartFailure. terminate() then emits `cancelled`
        // and aborts the session; do NOT go on to signal session-ready, which
        // would hand the runtime a "started" session that is actually dead,
        // holding it open until the idle timeout.
        await outcome.speakStartFailure();
        terminate();
        return;
      }
      // S2S fires onSessionReady when the provider acks; in pipeline mode the
      // equivalent "ready" signal is providers having opened.
      callbacks.onSessionReady?.(opts.sid);
      onAudioReady();
      // Covers the no-greeting case; a greeting in flight defers the nudge.
      nudger.arm();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      // Gate late inbound work (sendUserAudio into a closing STT session)
      // the same way a provider-error teardown does.
      terminated = true;
      gate.invalidateAll();
      nudger.clear();
      recovery.clear();
      speechEdges.reset();
      sessionAbort.abort();
      turns.abortCurrent();
      providers.unsubscribe();
      // Let an in-flight start() settle after the abort so any provider that
      // opened mid-connect is adopted-then-closed (openSide) before we close
      // below — otherwise a slow socket lands after stop() and lingers.
      if (startPromise !== null) await startPromise.catch(() => undefined);
      if (turnPromise !== null) await turnPromise.catch(() => undefined);
      await providers.close();
    },

    sendUserAudio(bytes: Uint8Array): void {
      if (terminated || !audioReady) return;
      providers.stt?.sendAudio(bytesToPcm16(bytes));
    },

    // Tool execution stays inside toVercelTools/streamText; results aren't
    // routed through the transport.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for pipeline mode
    sendToolResult(_callId: string, _result: string): void {},

    cancelReply(): void {
      if (terminated) return;
      // A client-initiated cancel is intentional — never resume from it.
      recovery.clear();
      // "Stop responding": strand turns already queued behind the cancelled
      // one. History persistence stays valid — the conversation continues.
      gate.invalidateQueued();
      abortInFlightTurn();
      // Silence after a client-initiated cancel should still nudge.
      nudger.arm();
      // Do NOT call callbacks.onCancelled() here — session-core.onCancel
      // (client-initiated) calls client.cancelled() itself. Barge-in fires
      // onCancelled directly in onSttPartial where the cancel originates here.
    },

    seedHistory(messages: readonly Message[]): void {
      // Client-resent history on reconnect; restore both views so the resumed
      // agent keeps memory of the prior conversation.
      history.seed(messages);
    },

    reset(): void {
      // Bumped before the abort/history.reset below so the aborted turn's
      // deferred persistence and any queued turns see the change.
      gate.invalidateAll();
      // A reset is user activity: restore the resume budget as well.
      recovery.onUserTurn();
      speechEdges.reset();
      abortInFlightTurn();
      history.reset();
      // A reset is user activity: restore the budget, restart the window.
      nudger.onUserSpeech();
    },
  };
}
