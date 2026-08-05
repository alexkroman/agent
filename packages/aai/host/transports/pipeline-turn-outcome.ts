// Copyright 2026 the AAI authors. MIT license.
/**
 * What to do with a pipeline turn once its LLM stream settles.
 *
 * A turn ends exactly one of three ways, and each has to leave the session in a
 * coherent state — history, the client transcript, and the STT provider's view
 * of the agent's own words:
 *
 * - **interrupted** by barge-in → {@link TurnOutcome.persistBargeIn}
 * - **failed** (the provider errored) → {@link TurnOutcome.speakRecovery}
 * - **spoke** normally → {@link TurnOutcome.finishSpokenTurn}
 *
 * Split out of `pipeline-transport.ts` so the turn body reads as those three
 * branches rather than their bodies inline; each needs the same handful of
 * session-scoped collaborators, which is what the factory closes over.
 */

import type { ModelMessage } from "ai";
import type { PipelineHistory } from "./pipeline-history.ts";
import { persistInterruptedTurn } from "./pipeline-history.ts";
import type { PipelineProviderSessions } from "./pipeline-providers.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";
import type { TransportCallbacks } from "./types.ts";

/** Session-scoped collaborators every outcome needs. */
export interface TurnOutcomeDeps {
  history: PipelineHistory;
  callbacks: TransportCallbacks;
  providers: PipelineProviderSessions;
  gate: TurnGate;
  /** Spoken after a failed turn; `""` disables. */
  errorPhrase: string;
  /** Spoken when a provider fails to open and the session cannot start; `""` disables. */
  startFailurePhrase: string;
  /** Per-turn TTS drain, bound to the session signal. */
  drainTts: () => Promise<void>;
  /** Forwards text to the active TTS session, reopening the audio gate.
   *  `publishTranscript: false` suppresses the interim transcript for a phrase
   *  the caller publishes as a final itself — see the definition in
   *  pipeline-transport.ts. */
  sendTtsText: (text: string, opts?: { publishTranscript?: boolean }) => void;
}

export interface TurnOutcome {
  /**
   * Barge-in mid-turn: keep the completed tool steps and the spoken-so-far
   * text. Skipped when the conversation has since been reset, so an interrupted
   * tail never lands in a fresh conversation. Emits nothing to the client — the
   * `cancelled` frame already ended this reply there, and the interim
   * transcripts already carried its text (see `persistInterruptedTurn`).
   *
   * `syntheticPrompt` — the turn's own user text, set only when that text was
   * INJECTED (a false-interruption resume prompt, a silence nudge) — is dropped
   * from history when this turn left nothing else behind. See
   * {@link PipelineHistory.dropTrailingUser}.
   */
  persistBargeIn(args: {
    historyEpoch: number;
    accumulated: string;
    persistedLen: number;
    stepMessages: ModelMessage[];
    syntheticPrompt?: string | undefined;
  }): void;
  /**
   * Speak `errorPhrase` after a failed LLM turn, so a provider outage hands the
   * conversation back instead of going quiet. Returns whether anything was
   * spoken.
   *
   * A failed turn produces no text — or a truncated fragment — so without this
   * the caller hears silence, or half a sentence and then silence, while the
   * only trace is a `llm` session error the browser surfaces without a sound.
   *
   * The caller must treat `true` as "this turn spoke": `runReply` skips
   * `drainTts` otherwise, and the drain is what flushes the provider. AssemblyAI
   * TTS synthesizes nothing until it is flushed, so an unreported phrase would
   * be silence too.
   *
   * Emitted as a transcript so the UI matches what was heard, but deliberately
   * NOT pushed into `history.llm`: teaching the model that its own replies open
   * with apologies is how it starts producing them unprompted. Same reasoning
   * as keeping the hold phrase and dead-air cover out of the record.
   */
  speakRecovery(failed: boolean): boolean;
  /** Announce and persist a turn that produced speech. */
  finishSpokenTurn(text: string): void;
  /**
   * Last words when the session cannot start.
   *
   * A provider open failed, so there is no conversation to have — but the two
   * sides open independently, and the usual failure is STT missing while TTS
   * connected. That leaves a working voice and nothing to listen with, and
   * saying nothing hands the caller a line that sounds connected and never
   * answers. Skipped when TTS is the side that failed (nothing to speak with)
   * or the phrase is disabled.
   *
   * Not a reply: no reply id, no history, no turn. Just the sentence and its
   * audio, drained before the caller's teardown discards what is still queued.
   */
  speakStartFailure(): Promise<void>;
}

export function createTurnOutcome(deps: TurnOutcomeDeps): TurnOutcome {
  const { history, callbacks, providers, gate, errorPhrase, sendTtsText } = deps;
  const { startFailurePhrase, drainTts } = deps;
  return {
    persistBargeIn(args) {
      if (!gate.historyCurrent(args.historyEpoch)) return;
      // Computed before persisting, while the synthetic prompt is still the
      // trailing message: nothing was persisted exactly when there are no
      // completed steps and no spoken text.
      const leftNoTrace = args.stepMessages.length === 0 && args.accumulated.trim().length === 0;
      persistInterruptedTurn({
        history,
        accumulated: args.accumulated,
        persistedLen: args.persistedLen,
        stepMessages: args.stepMessages,
        updateAgentContext: (text) => providers.stt?.updateAgentContext?.(text),
      });
      if (args.syntheticPrompt !== undefined && leftNoTrace) {
        history.dropTrailingUser(args.syntheticPrompt);
      }
    },

    speakRecovery(failed) {
      if (!failed || errorPhrase.length === 0) return false;
      sendTtsText(errorPhrase);
      callbacks.onAgentTranscript(errorPhrase, false);
      return true;
    },

    async speakStartFailure() {
      if (startFailurePhrase.length === 0 || !providers.tts) return;
      callbacks.onAgentTranscript(startFailurePhrase, false);
      sendTtsText(startFailurePhrase, { publishTranscript: false });
      await drainTts().catch(() => undefined);
    },

    finishSpokenTurn(text) {
      callbacks.onAgentTranscript(text, false);
      history.pushConversation({ role: "assistant", content: text });
      // Seed the STT provider with the agent's side of the dialog (AssemblyAI
      // Universal-3.5 Pro only; other providers have no such hook).
      providers.stt?.updateAgentContext?.(text);
    },
  };
}
