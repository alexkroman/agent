// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// A `tool.called` report is observability-only here; runtime.ts routes it to
// `client.toolCall` directly (bypassing ServerSession's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import { setMaxListeners } from "node:events";
import type { Message } from "@alexkroman1/aai";
import { normalizeSpeechText } from "@alexkroman1/aai/internal";
import { bytesToPcm16, pcm16ToBytes } from "../_pcm.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createContextBudget } from "./pipeline-context-budget.ts";
import { createEmitError } from "./pipeline-error.ts";
import { createHeardTracker } from "./pipeline-heard.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import { createTurnLlmRunner } from "./pipeline-llm-stream.ts";
import { createPipelineProviderSessions } from "./pipeline-providers.ts";
import { createPipelineSpeculation } from "./pipeline-speculation.ts";
import { flushTtsAndWait } from "./pipeline-stream.ts";
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
import type { SendTtsOptions, Transport } from "./types.ts";

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
    speechIdleTimeoutMs,
    toolChoice,
    toolSchemas,
    executeTool,
  } = resolvePipelineOptions(opts);

  const { callbacks, sessionConfig } = opts;
  const systemPrompt = sessionConfig.systemPrompt;
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
  // Built once per SESSION, deliberately: neither of those changes between
  // turns, so what one turn's last step measured is the right number for the
  // next turn's first step — the step that would otherwise be estimated blind,
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

  // PREEMPTIVE GENERATION (on by default). Constructed before the speech
  // handlers because they drive it, and deliberately NOT wired into `turns` or
  // the turn chain: a speculation occupies no turn, so every barge-in gate
  // below behaves exactly as it does with the flag off. See
  // pipeline-speculation.ts.
  const speculation = createPipelineSpeculation({
    enabled: preemptiveGeneration,
    toolChoice,
    toolSchemas,
    llm: opts.llm,
    systemPrompt,
    temperature: opts.temperature,
    maxSteps,
    // The SAME preparer the real turn gets: a speculation is adopted into a
    // turn, and request parity is the premise adoption rests on.
    contextBudget,
    history,
    sessionSignal: sessionAbort.signal,
    // "The floor is free": no turn running and nothing still playing out.
    isIdle: () => !(turns.inFlight() || heard.pending()),
    log,
    sid: opts.sid,
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
    minBargeInWords,
    interruptionMinDurationMs,
    isTerminated: () => terminated,
    isSessionActive: () => !(terminated || sessionAbort.signal.aborted),
    isTurnInFlight: () => turns.inFlight(),
    isTurnDraining: () => turns.draining(),
    isResumeTurnInFlight: () => turns.resumeInFlight(),
    hasTurnSpoken: () => turns.spoke(),
    isPlaybackPending: () => heard.pending(),
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
    messages: () => history.conversation,
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
  function sendTtsText(text: string, opts?: SendTtsOptions): void {
    turns.openAudioGate();
    // ASCII-fold typographic quotes for the engine; length-preserving, so the
    // heard cursor below still indexes the same positions (normalizeSpeechText).
    providers.tts?.sendText(normalizeSpeechText(text));
    const tail = heard.onText(text, opts?.record !== false);
    if (opts?.publishTranscript !== false)
      callbacks.report({ type: "agent-transcript.updated", text: tail });
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

  const consumeLlmStream = createTurnLlmRunner({
    llm: opts.llm,
    systemPrompt,
    messages: history.llm,
    tools,
    toolChoice,
    temperature: opts.temperature,
    maxSteps,
    contextBudget,
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

  return {
    start: () => lifecycle.start(),

    stop: () => lifecycle.stop(),

    sendUserAudio(bytes: Uint8Array): void {
      if (terminated || !lifecycle.audioReady()) return;
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
      speculation.discard("reset");
      abortInFlightTurn();
      // Silence after a client-initiated cancel should still nudge.
      nudger.arm();
      // Do NOT report `reply.cancelled` here — the session's own `cancel` command
      // (client-initiated) calls client.cancelled() itself. Barge-in fires
      // onCancelled directly in onSttPartial where the cancel originates here.
    },

    injectTurn(instruction: string): void {
      if (terminated) return;
      // The same path the silence nudge takes — queued on the turn chain, so it
      // waits its turn behind a reply in flight rather than talking over one,
      // and `synthetic` keeps the instruction out of the user transcript while
      // leaving it in the LLM's history where the reply is built from it.
      runChainedTurn(instruction, "Pipeline injected turn crashed", { synthetic: true });
    },

    seedHistory(messages: readonly Message[]): void {
      // Client-resent history on reconnect; restore both views so the resumed
      // agent keeps memory of the prior conversation.
      history.seed(messages);
    },

    onPlaybackProgress(bufferedMs: number): void {
      // The one closed-loop input to a playback estimate that is otherwise
      // bytes-sent times 1.0x — see the `playback_progress` doc in
      // sdk/protocol.ts for what it costs when the client drains slower, and
      // `PlaybackClock.onClientReport` for why it may only ever clamp upward.
      // Ignored after teardown: the clock belongs to a session that is gone.
      if (terminated) return;
      heard.onClientPlaybackReport(bufferedMs);
    },

    reset(): void {
      // Bumped before the abort/history.reset below so the aborted turn's
      // deferred persistence and any queued turns see the change.
      gate.invalidateAll();
      // A reset is user activity: restore the resume budget as well.
      recovery.onUserTurn();
      speechEdges.reset();
      speculation.discard("reset");
      abortInFlightTurn();
      history.reset();
      // A reset is user activity: restore the budget, restart the window.
      nudger.onUserSpeech();
      // A reset starts a NEW conversation, so it opens the way every
      // conversation does. Queued after the invalidateAll above, so the
      // greeting turn's epoch is the fresh one and the strand does not catch
      // it; queued on the turn chain, so it runs after the aborted turn
      // unwinds rather than interleaving with it.
      lifecycle.greet();
    },
  };
}
