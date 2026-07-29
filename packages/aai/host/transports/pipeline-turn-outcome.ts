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
  /** Excluded from persisted history — see {@link persistInterruptedTurn}. */
  holdPhrase: string;
  /** Spoken after a failed turn; `""` disables. */
  errorPhrase: string;
  /** Forwards text to the active TTS session, reopening the audio gate. */
  sendTtsText: (text: string) => void;
}

export interface TurnOutcome {
  /**
   * Barge-in mid-turn: keep the completed tool steps and the spoken-so-far
   * text. Skipped when the conversation has since been reset, so an interrupted
   * tail never lands in a fresh conversation.
   */
  persistBargeIn(args: {
    historyEpoch: number;
    accumulated: string;
    persistedLen: number;
    stepMessages: ModelMessage[];
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
   * with apologies is how it starts producing them unprompted. Same reasoning as
   * `persistInterruptedTurn` excluding the hold phrase.
   */
  speakRecovery(failed: boolean): boolean;
  /** Announce and persist a turn that produced speech. */
  finishSpokenTurn(text: string): void;
}

export function createTurnOutcome(deps: TurnOutcomeDeps): TurnOutcome {
  const { history, callbacks, providers, gate, holdPhrase, errorPhrase, sendTtsText } = deps;
  return {
    persistBargeIn(args) {
      if (!gate.historyCurrent(args.historyEpoch)) return;
      persistInterruptedTurn({
        history,
        accumulated: args.accumulated,
        persistedLen: args.persistedLen,
        stepMessages: args.stepMessages,
        holdPhrase,
        onTranscript: (text) => callbacks.onAgentTranscript(text, true),
        updateAgentContext: (text) => providers.stt?.updateAgentContext?.(text),
      });
    },

    speakRecovery(failed) {
      if (!failed || errorPhrase.length === 0) return false;
      sendTtsText(errorPhrase);
      callbacks.onAgentTranscript(errorPhrase, false);
      return true;
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
