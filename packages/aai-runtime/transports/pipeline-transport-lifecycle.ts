// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline transport's SESSION lifecycle — everything that happens once
 * per call rather than once per turn: opening the providers, the greeting,
 * the two unrecoverable provider failures, and both ways a session ends.
 *
 * Split from pipeline-transport.ts, which keeps turn orchestration. The line
 * between them is the one the rest of that file is organized around: a turn
 * can fail without ending the session (see "A failing TURN is not a failing
 * SESSION" in the package guide), and every path in HERE is the other kind.
 * Keeping them apart is what stops a turn-level fix reaching for `terminate`.
 *
 * The `terminated` flag stays with the transport rather than moving here,
 * because half its readers are turn-level (`sendUserAudio`, `cancelReply`,
 * the user-activity predicates); this module gets it as a getter plus the one
 * setter, so there is still exactly one flag.
 */

import type { SttError, TtsError } from "@alexkroman1/aai/host-internal";
import type { Logger } from "../runtime-config.ts";
import type { PipelineHistory } from "./pipeline-history.ts";
import type { PipelineProviderSessions } from "./pipeline-providers.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import type { TurnChain, TurnGate } from "./pipeline-turn-gate.ts";
import type { TurnOutcome } from "./pipeline-turn-outcome.ts";
import type { TurnMachine } from "./pipeline-turn-state.ts";
import type { UserActivity } from "./pipeline-user-speech.ts";
import {
  type EmitError,
  type SendTtsText,
  type SkipGreeting,
  shouldSkipGreeting,
  type TransportCallbacks,
} from "./types.ts";

/** What {@link createPipelineLifecycle} hands back to the transport. */
export interface PipelineLifecycle {
  /** Open the providers, then greet — the transport's `start`. */
  start(): Promise<void>;
  /** Client disconnect — the transport's `stop`. */
  stop(): Promise<void>;
  /** Either provider failing is unrecoverable: surface it and tear down. */
  onProviderError(kind: "stt" | "tts", err: SttError | TtsError): void;
  /**
   * TTS has been adopted, so audio can flow: fire the greeting turn (once).
   * Wired into the provider sessions, which is why this is public.
   */
  onAudioReady(): void;
  /**
   * Queue the greeting turn. Called at session start via
   * {@link PipelineLifecycle.onAudioReady} and again by the transport's
   * `reset()` — a client `reset` discards the conversation, and a conversation
   * that starts without its opening line is not the one the agent declares.
   *
   * No-op with no greeting configured, before TTS is adopted (there is nothing
   * to speak into yet — the start path greets as soon as it is), or after
   * teardown.
   */
  greet(): void;
  /**
   * Has {@link PipelineLifecycle.onAudioReady} fired? The transport gates
   * inbound audio on it — STT is not open before that, so forwarding frames
   * would write into a session that does not exist yet.
   */
  audioReady(): boolean;
}

export interface PipelineLifecycleDeps {
  sid: string;
  log: Logger;
  callbacks: TransportCallbacks;
  emitError: EmitError;
  /** Session-lifetime abort — combined into every turn's own signal. */
  sessionAbort: AbortController;
  greeting: string | undefined;
  skipGreeting: SkipGreeting | undefined;

  gate: TurnGate;
  turns: TurnMachine;
  turnChain: TurnChain;
  history: PipelineHistory;
  outcome: TurnOutcome;
  speculation: Pick<SpeculationController, "discard">;
  nudger: UserActivity["nudger"];
  recovery: UserActivity["recovery"];
  speechEdges: UserActivity["speechEdges"];
  /**
   * The provider pair. A getter, not the value: the sessions are constructed
   * with `onAudioReady`/`onProviderError` from THIS module, so one of the two
   * has to reach the other lazily.
   */
  providers: () => PipelineProviderSessions;

  isTerminated: () => boolean;
  /** Latch the transport's `terminated` flag — see the module doc. */
  markTerminated: () => void;
  abortInFlightTurn: () => void;
  sendTtsText: SendTtsText;
  runReply: (
    idPrefix: string,
    body: (signal: AbortSignal) => Promise<boolean /* spoke */>,
  ) => Promise<void>;
  /** Turn-crash handler for `turnChain.chain` call sites — see turnCrashLogger. */
  logTurnCrash: (label: string) => (err: unknown) => void;
}

export function createPipelineLifecycle(deps: PipelineLifecycleDeps): PipelineLifecycle {
  const {
    sid,
    log,
    callbacks,
    emitError,
    sessionAbort,
    gate,
    turns,
    turnChain,
    history,
    outcome,
    speculation,
    nudger,
    recovery,
    speechEdges,
    isTerminated,
    markTerminated,
    abortInFlightTurn,
    sendTtsText,
    runReply,
    logTurnCrash,
  } = deps;

  let audioReady = false;
  // The in-flight providers.open() from start(). stop() awaits it so a
  // disconnect mid-connect tears the just-opened provider sockets down
  // deterministically instead of leaving fire-and-forget opens to pile up.
  let startPromise: Promise<"ok" | "failed"> | null = null;

  /**
   * Everything both teardown paths clear — the difference is what follows.
   *
   * The provider unsubscribe belongs HERE and not only in `stop()`. A
   * terminate left every STT/TTS listener attached and rested on four separate
   * guards downstream (the audio gate, `isTerminated` in the STT handlers, the
   * aborted session signal, the `isTerminated` check in `onProviderError`) to
   * make sure nothing acted on what still arrived — four things that each have
   * to keep being true, in a teardown whose whole job is that nothing further
   * happens. Idempotent, so the pairing with `stop()` costs nothing.
   */
  function quiesce(): void {
    gate.invalidateAll();
    nudger.clear();
    recovery.clear();
    speechEdges.reset();
    speculation.discard("reset");
    deps.providers().unsubscribe();
  }

  // Idempotent teardown after an unrecoverable provider error.
  function terminate(): void {
    if (isTerminated()) return;
    markTerminated();
    quiesce();
    abortInFlightTurn();
    callbacks.report({ type: "reply.cancelled" });
    sessionAbort.abort();
    // Close whatever was adopted before the failure (e.g. TTS went live,
    // then STT's open failed) — it must not outlive the terminate.
    deps
      .providers()
      .close()
      .catch(() => {
        // Best-effort teardown; a failed close is not actionable here.
      });
  }

  function onProviderError(kind: "stt" | "tts", err: SttError | TtsError): void {
    if (isTerminated()) return;
    log.error(`${kind.toUpperCase()} error`, {
      code: err.code,
      message: err.message,
      sid,
    });
    emitError(kind, err.message);
    terminate();
  }

  function runGreeting(text: string): Promise<void> {
    return runReply("pipeline-greeting", async () => {
      callbacks.report({ type: "agent-transcript.committed", text });
      history.pushConversation({ role: "assistant", content: text });
      history.pushLlm({ role: "assistant", content: text });
      sendTtsText(text, { publishTranscript: false });
      // Push the greeting mid-stream too (it was already seeded at STT connect
      // time) — covers providers that only support the mid-stream hook.
      deps.providers().stt?.updateAgentContext?.(text);
      return true;
    });
  }

  function greet(): void {
    if (!audioReady || isTerminated()) return;
    const greeting = deps.greeting;
    if (!greeting) return;
    turnChain.chain(() => runGreeting(greeting).catch(logTurnCrash("Pipeline greeting failed")));
  }

  function onAudioReady(): void {
    if (audioReady || isTerminated()) return;
    audioReady = true;
    // `skipGreeting` is a RESUME flag and scoped to this connection's START:
    // a reconnect rejoins a conversation already in progress, so re-greeting
    // there would repeat a line the caller has heard. It deliberately does not
    // reach `greet()`, because a later `reset()` is the opposite case — the
    // conversation is discarded and the next one begins.
    //
    // RESOLVED here rather than read as a boolean, and this call site is why the
    // field may be a thunk: by now the resume's lookups have run, so "the caller
    // presented an id" has become "the id named something". A resume that found
    // nothing greets — see `host/session-resume-found.ts`.
    if (shouldSkipGreeting(deps.skipGreeting)) return;
    greet();
  }

  return {
    onProviderError,
    onAudioReady,
    greet,
    audioReady: () => audioReady,

    async start(): Promise<void> {
      // STT and TTS open concurrently; a failed side (with the session still
      // live) tears the whole transport down.
      startPromise = deps.providers().open();
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
      onAudioReady();
      // Covers the no-greeting case; a greeting in flight defers the nudge.
      nudger.arm();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      // Gate late inbound work (sendUserAudio into a closing STT session)
      // the same way a provider-error teardown does.
      markTerminated();
      quiesce();
      sessionAbort.abort();
      turns.abortCurrent();
      // Let an in-flight start() settle after the abort so any provider that
      // opened mid-connect is adopted-then-closed (openSide) before we close
      // below — otherwise a slow socket lands after stop() and lingers.
      if (startPromise !== null) await startPromise.catch(() => undefined);
      await turnChain.settled();
      await deps.providers().close();
    },
  };
}
