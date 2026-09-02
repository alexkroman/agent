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
 *
 * ## The two kinds of phrase the transport speaks on its own
 *
 * `errorPhrase` and `startFailurePhrase` — both here — are **failure
 * recovery**, not latency cover, and the distinction decides how they are
 * emitted. Keeping them apart matters because they look interchangeable with
 * the third mechanism and are not:
 *
 * | | dead-air cover (`pipeline-stream-parts.ts`) | failure phrases (here) |
 * | --- | --- | --- |
 * | why | the turn is taking a long time | the turn, or the session, failed |
 * | client transcript | INTERIM only (`record: false`) | FINAL, tagged `recovery` |
 * | history / `ctx.messages` | never | never |
 *
 * The cover is a timing artifact the caller hears, so it must match the audio
 * in the live caption and vanish from the committed message; that is the whole
 * point of `emitText(phrase, false)`. A failure phrase is the turn's actual
 * outcome — it IS what the agent said — so it reaches the final transcript.
 *
 * **Neither kind enters history, for the same measured reason stated twice
 * over**: teaching the model that its own replies open with apologies (or with
 * filler) is how it starts producing them unprompted. That asymmetry — same
 * history rule, opposite transcript rule — is what a future attempt to unify
 * the three into one helper would get wrong, so they stay separate. The two
 * failure phrases stay separate from EACH OTHER too: their lifecycles really
 * do differ (one inside a reply, one outside any reply, with its own drain and
 * `publishTranscript: false`), and merging them would erase the difference
 * that is the point.
 *
 * ## The `never` in that row is on the WIRE, because it could not be kept here
 *
 * This module can only decline to push; it cannot stop a reader that sees the
 * committed transcript from recording it, and for a long time two of them did.
 * `agent-transcript.committed` was the same event for a reply and for an
 * apology, so `session-core.ts`'s live dispatch appended the phrase to
 * `ctx.messages` on the same call the caller heard it, and
 * `messagesFromEvents` handed it back to the model on the first reconnect —
 * compounding, since every reconnect re-seeds. Both phrases therefore carry
 * `recovery` (`AgentTranscriptRecovery`, `sdk/protocol-events.ts`), the
 * only thing on the wire that says an utterance was SPOKEN and is not part of
 * the record, and `historyMessageOf` (`session-event-history.ts`) is the one
 * reader of it. Adding a third phrase means tagging it: an untagged committed
 * transcript is a reply, by definition and by every older log.
 */

import type { ModelMessage } from "ai";
import type { PipelineHistory } from "./pipeline-history.ts";
import { persistInterruptedTurn } from "./pipeline-history.ts";
import type { PipelineProviderSessions } from "./pipeline-providers.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";
import type { SendTtsText, TransportCallbacks } from "./types.ts";

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
  sendTtsText: SendTtsText;
}

export interface TurnOutcome {
  /**
   * Barge-in mid-turn: keep the completed tool steps and the text the caller
   * actually HEARD. Skipped when the conversation has since been reset, so an
   * interrupted tail never lands in a fresh conversation. Emits nothing to the
   * client — the `cancelled` frame already ended this reply there, and the
   * interim transcripts already carried its text (see
   * `persistInterruptedTurn`).
   *
   * `syntheticPrompt` — the turn's own user text, set only when that text was
   * INJECTED (a false-interruption resume prompt, a silence nudge) — is dropped
   * from history when this turn left nothing else behind. See
   * {@link PipelineHistory.dropTrailingUser}.
   */
  persistBargeIn(args: {
    historyEpoch: number;
    /** Everything the model generated before the abort. */
    accumulated: string;
    /**
     * How much of `accumulated` the caller is estimated to have heard, in
     * characters — the heard cursor (`pipeline-heard.ts`). Only this prefix is
     * recorded.
     */
    heardChars: number;
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
   * NOT pushed into `history.llm`, and tagged `recovery: "turn-failed"` so no
   * READER of the stream records it either: teaching the model that its own
   * replies open with apologies is how it starts producing them unprompted.
   * Same reasoning as keeping the dead-air cover out of the record — see the
   * module doc for why the transcript rule nonetheless goes the other way, and
   * for the two readers that used to put the phrase back.
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
   * Tagged `recovery: "session-failed"` for the reason `speakRecovery`'s twin
   * is tagged — a reader cannot otherwise tell this from something the agent
   * chose to say.
   */
  speakStartFailure(): Promise<void>;
}

export function createTurnOutcome(deps: TurnOutcomeDeps): TurnOutcome {
  const { history, callbacks, providers, gate, errorPhrase, sendTtsText } = deps;
  const { startFailurePhrase, drainTts } = deps;
  return {
    persistBargeIn(args) {
      if (!gate.historyCurrent(args.historyEpoch)) return;
      const heard = args.accumulated.slice(0, args.heardChars);
      // Computed before persisting, while the synthetic prompt is still the
      // trailing message: nothing was persisted exactly when there are no
      // completed steps and nothing the caller heard.
      //
      // It MUST read the same `heard` string that decides whether a message is
      // written, not `accumulated`. A resume turn that generated text but
      // played none writes no assistant message, so reading `accumulated` here
      // would leave its synthetic prompt ("the user did not actually say
      // anything…") standing unanswered directly ahead of the next real user
      // turn — the two-contradictory-user-messages failure `dropTrailingUser`
      // exists for.
      const leftNoTrace = args.stepMessages.length === 0 && heard.trim().length === 0;
      persistInterruptedTurn({
        history,
        heard,
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
      callbacks.report({
        type: "agent-transcript.committed",
        text: errorPhrase,
        recovery: "turn-failed",
      });
      return true;
    },

    async speakStartFailure() {
      if (startFailurePhrase.length === 0 || !providers.tts) return;
      callbacks.report({
        type: "agent-transcript.committed",
        text: startFailurePhrase,
        recovery: "session-failed",
      });
      sendTtsText(startFailurePhrase, { publishTranscript: false });
      await drainTts().catch(() => undefined);
    },

    finishSpokenTurn(text) {
      callbacks.report({ type: "agent-transcript.committed", text });
      history.pushConversation({ role: "assistant", content: text });
      // Seed the STT provider with the agent's side of the dialog (AssemblyAI
      // Universal-3.5 Pro only; other providers have no such hook).
      providers.stt?.updateAgentContext?.(text);
    },
  };
}
