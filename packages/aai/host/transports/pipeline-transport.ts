// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// `callbacks.onToolCall` is observability-only; runtime.ts routes it to
// `client.toolCall` directly (bypassing SessionCore's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import type { ModelMessage } from "ai";
import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_SILENCE_PROMPT,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
} from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { SttError, TtsError } from "../../sdk/providers.ts";
import type { Message } from "../../sdk/types.ts";
import { errorMessage } from "../../sdk/utils.ts";
import { bytesToPcm16, pcm16ToBytes } from "../_pcm.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createEndpointSettler } from "./pipeline-endpointing.ts";
import { createPipelineHistory, persistInterruptedTurn } from "./pipeline-history.ts";
import { createPipelineProviderSessions } from "./pipeline-providers.ts";
import { createToolCallRepair } from "./pipeline-repair.ts";
import { createSilenceNudger } from "./pipeline-silence.ts";
import {
  createPlaybackClock,
  flushTtsAndWait,
  consumeLlmStream as runLlmStream,
} from "./pipeline-stream.ts";
import {
  type PipelineTransportOptions,
  resolvePipelineOptions,
} from "./pipeline-transport-options.ts";
import {
  createFalseInterruptionRecovery,
  createSpeechEdgeTracker,
  createSttEventHandlers,
} from "./pipeline-user-speech.ts";
import type { Transport } from "./types.ts";

export type { PipelineTransportOptions } from "./pipeline-transport-options.ts";

/** Create a pipeline-mode Transport (STT → LLM → TTS). */
export function createPipelineTransport(opts: PipelineTransportOptions): Transport {
  const {
    log,
    sttSampleRate,
    ttsSampleRate,
    maxSteps,
    minBargeInWords,
    interruptionMinDurationMs,
    endpointSettleMs,
    completeSettleMs,
    holdPhrase,
    falseInterruptionTimeoutMs,
    toolChoice,
    toolSchemas,
    executeTool,
  } = resolvePipelineOptions(opts);

  const { callbacks, sessionConfig } = opts;
  const systemPrompt = sessionConfig.systemPrompt;

  const sessionAbort = new AbortController();
  let audioReady = false;
  let terminated = false;
  let turnController: AbortController | null = null;
  let nextReplyId = 0;
  // Repair reuses the in-flight turn's abort signal so a repair call is
  // cancelled on barge-in/cancel/disconnect instead of running on orphaned.
  const repairToolCall = createToolCallRepair(opts.llm, log, () => turnController?.signal);
  // Endpoint settling: STT finals buffer until a settle window elapses so
  // disfluent multi-final utterances commit as one turn (pipeline-endpointing.ts).
  const settler = createEndpointSettler({
    settleMs: endpointSettleMs,
    completeSettleMs,
    onCommit: (text) => {
      if (terminated) return;
      speechEdges.speechEnded();
      callbacks.onUserTranscript(text);
      chainTurn(() =>
        runTurn(text).catch((err: unknown) => {
          log.error("Pipeline turn crashed", { error: errorMessage(err), sid: opts.sid });
        }),
      );
    },
  });
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

  // Silence nudge: `silencePrompt` becomes a synthetic user message (in LLM
  // history, never a user transcript). Countdown/budget rules: pipeline-silence.ts.
  const silencePrompt = opts.silencePrompt ?? DEFAULT_SILENCE_PROMPT;
  const nudger = createSilenceNudger({
    timeoutMs: opts.silenceTimeoutMs,
    isActive: () => !(terminated || sessionAbort.signal.aborted),
    isTurnInFlight: () => turnController !== null || playbackClock.pending(),
    onNudge(consecutive) {
      log.info("Pipeline silence nudge", { sid: opts.sid, consecutive });
      chainTurn(() =>
        runTurn(silencePrompt).catch((err: unknown) => {
          log.error("Pipeline silence nudge crashed", { error: errorMessage(err), sid: opts.sid });
        }),
      );
    },
  });

  // Pipeline mode has no VAD: speech_started/speech_stopped derive from the
  // STT transcript stream (see pipeline-user-speech.ts).
  const speechEdges = createSpeechEdgeTracker(callbacks, {
    idleTimeoutMs: DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  });

  // Resume a barged-in reply when the interruption never commits a user turn
  // — its spoken-so-far text is already in history marked `[interrupted]`,
  // so a synthetic continuation turn picks up where it was cut off.
  const recovery = createFalseInterruptionRecovery({
    timeoutMs: falseInterruptionTimeoutMs,
    maxConsecutive: MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
    isActive: () => !terminated,
    isBusy: () => turnController !== null || playbackClock.pending(),
    onResume: () => {
      log.info("Pipeline false-interruption resume", { sid: opts.sid });
      speechEdges.speechEnded();
      chainTurn(() =>
        runTurn(DEFAULT_FALSE_INTERRUPTION_PROMPT).catch((err: unknown) => {
          log.error("Pipeline false-interruption resume crashed", {
            error: errorMessage(err),
            sid: opts.sid,
          });
        }),
      );
    },
  });

  // Interpret the STT transcript stream: speaking edges, live captions,
  // barge-in policy and settled turns (pipeline-user-speech.ts).
  const sttEvents = createSttEventHandlers({
    isTerminated: () => terminated,
    isTurnInFlight: () => turnController !== null,
    isPlaybackPending: () => playbackClock.pending(),
    abortInFlightTurn: () => abortInFlightTurn(),
    speechEdges,
    recovery,
    settler,
    nudger,
    callbacks,
    minBargeInWords,
    interruptionMinDurationMs,
    log,
    sid: opts.sid,
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
    turnPromise = (turnPromise ?? Promise.resolve()).then(start);
  }

  function emitError(code: SessionErrorCode, message: string): void {
    callbacks.onError(code, message);
  }

  /** Abort the in-flight turn (if any) and cancel TTS playback. */
  function abortInFlightTurn(): void {
    turnController?.abort();
    turnController = null;
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
    nudger.clear();
    recovery.clear();
    speechEdges.reset();
    settler.reset();
    abortInFlightTurn();
    callbacks.onCancelled();
    sessionAbort.abort();
    // Close whatever was adopted before the failure (e.g. TTS went live,
    // then STT's open failed) — it must not outlive the terminate.
    void providers.close();
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

  const consumeLlmStream = (
    ctl: AbortController,
    onDelta: (delta: string) => void,
    onStepPersisted?: () => void,
  ): Promise<ModelMessage[]> =>
    runLlmStream({
      llm: opts.llm,
      systemPrompt,
      messages: history.llm,
      tools,
      toolChoice,
      temperature: opts.temperature,
      repairToolCall,
      maxSteps,
      holdPhrase,
      sendTtsText: (text) => providers.tts?.sendText(text),
      callbacks,
      emitError,
      log,
      sid: opts.sid,
      ctl,
      onDelta,
      onStepPersisted,
    });

  /** Per-turn TTS drain — see flushTtsAndWait in pipeline-stream.ts. */
  function drainTts(signal: AbortSignal): Promise<void> {
    return flushTtsAndWait({ tts: providers.tts, signal, log, sid: opts.sid });
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
    body: (ctl: AbortController) => Promise<boolean /* spoke */>,
  ): Promise<void> {
    callbacks.onReplyStarted(`${idPrefix}-${++nextReplyId}`);

    const ctl = new AbortController();
    turnController = ctl;

    const spoke = await body(ctl);
    if (spoke && !ctl.signal.aborted) await drainTts(ctl.signal);

    if (!ctl.signal.aborted) callbacks.onReplyDone();
    // Clear the controller unless a newer turn replaced it.
    if (turnController === ctl) turnController = null;
    // Aborted turns skip the re-arm: onSttPartial / cancelReply handle those.
    if (!ctl.signal.aborted) nudger.arm();
  }

  function runTurn(userText: string): Promise<void> {
    return runReply("pipeline", async (ctl) => {
      history.pushConversation({ role: "user", content: userText });
      history.pushLlm({ role: "user", content: userText });

      let accumulated = "";
      // Portion of `accumulated` already inside persisted step messages.
      let persistedLen = 0;
      const onDelta = (delta: string): void => {
        accumulated += delta;
      };
      const responseMessages = await consumeLlmStream(ctl, onDelta, () => {
        persistedLen = accumulated.length;
      });

      if (ctl.signal.aborted) {
        // Barge-in mid-turn: keep the completed tool steps and the
        // spoken-so-far text — see persistInterruptedTurn.
        persistInterruptedTurn({
          history,
          accumulated,
          persistedLen,
          stepMessages: responseMessages,
          holdPhrase,
          onTranscript: (text) => callbacks.onAgentTranscript(text, true),
          updateAgentContext: (text) => providers.stt?.updateAgentContext?.(text),
        });
        return false;
      }

      // Persist the assistant tool-call message(s) and their `tool` results so
      // the next turn retains tool context, not just the spoken transcript.
      if (responseMessages.length > 0) history.pushLlm(...responseMessages);

      if (accumulated.length === 0) return false;
      callbacks.onAgentTranscript(accumulated, false);
      history.pushConversation({ role: "assistant", content: accumulated });
      // Seed the STT provider with the agent's side of the dialog (AssemblyAI
      // Universal-3.5 Pro only; other providers have no such hook).
      providers.stt?.updateAgentContext?.(accumulated);
      return true;
    });
  }

  function runGreeting(text: string): Promise<void> {
    return runReply("pipeline-greeting", async () => {
      callbacks.onAgentTranscript(text, false);
      history.pushConversation({ role: "assistant", content: text });
      history.pushLlm({ role: "assistant", content: text });
      providers.tts?.sendText(text);
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
    chainTurn(() =>
      runGreeting(greeting).catch((err: unknown) => {
        log.error("Pipeline greeting failed", { error: errorMessage(err), sid: opts.sid });
      }),
    );
  }

  return {
    async start(): Promise<void> {
      // STT and TTS open concurrently; a failed side (with the session still
      // live) tears the whole transport down.
      startPromise = providers.open();
      if ((await startPromise) === "failed") terminate();
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
      nudger.clear();
      recovery.clear();
      speechEdges.reset();
      settler.reset();
      sessionAbort.abort();
      turnController?.abort();
      providers.unsubscribe();
      // Let an in-flight start() settle after the abort so any provider that
      // opened mid-connect is adopted-then-closed (openSide) before we close
      // below — otherwise a slow socket lands after stop() and lingers.
      if (startPromise !== null) await startPromise.catch(() => undefined);
      if (turnPromise !== null) await turnPromise;
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
      // A reset is user activity: restore the resume budget as well.
      recovery.onUserTurn();
      speechEdges.reset();
      settler.reset();
      abortInFlightTurn();
      history.reset();
      // A reset is user activity: restore the budget, restart the window.
      nudger.onUserSpeech();
    },
  };
}
