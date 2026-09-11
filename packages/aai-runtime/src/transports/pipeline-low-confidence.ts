// Copyright 2026 the AAI authors. MIT license.
/**
 * `AgentDef.lowConfidence` as the pipeline applies it: the gate over a
 * committed transcript, the annotation it may add to the MODEL's copy, and the
 * one sentence the transport speaks on its own behalf when it fires.
 *
 * Split out of `pipeline-user-speech.ts` and `pipeline-transport.ts` because
 * it is one concern living in two files — a policy read in the STT final
 * handler and a reply spoken from the turn orchestrator — and because both of
 * those files sit against the source-length cap.
 *
 * The POLICY itself is the SDK's (`sdk/low-confidence.ts`, pure and testable
 * without a transport): three bands, two numbers, `undefined` confidence
 * always accepted. What is here is everything that needs a session.
 */

import type { ResolvedLowConfidence, SttTurnMeta } from "@alexkroman1/aai/host-internal";
import { classifyConfidence } from "@alexkroman1/aai/host-internal";
import { assembleSpelledRuns } from "@alexkroman1/aai/internal";
import type { Logger } from "../runtime-config.ts";
import type { SendTtsText, TransportCallbacks } from "./types.ts";

/**
 * Which per-turn confidence the policy compares — the statistic it names, off
 * the provider's meta, or `undefined` when the provider reported none.
 *
 * A function rather than a field read at the call site because the two
 * statistics are the same kind of thing measured at different sensitivities,
 * and which one is right is an open question (`LowConfidenceStatistic`): one
 * selector keeps the answer in one place for the day it is settled.
 */
function confidenceFor(
  meta: SttTurnMeta | undefined,
  policy: ResolvedLowConfidence,
): number | undefined {
  return policy.statistic === "minWord" ? meta?.minWordConfidence : meta?.transcriptConfidence;
}

/** What the gate says about one committed transcript. @internal */
export type LowConfidenceOutcome =
  /** This utterance must not become a turn — it was dropped, or answered. */
  | "handled"
  /** Run the turn, with this note appended to the model's copy. */
  | { note: string }
  /** Nothing to do: no policy, no opinion from the provider, or a good turn. */
  | undefined;

/** The gate the STT final handler consults. @internal */
export interface LowConfidenceGate {
  classify(text: string, meta: SttTurnMeta | undefined): LowConfidenceOutcome;
}

/**
 * Bind the policy to one session's collaborators.
 *
 * `undefined` for an agent that declares no policy, which is what the handler
 * reads as "commit every final" — the behaviour that shipped before the field
 * existed, with no closure call per turn.
 *
 * Both handled arms leave the utterance looking to the rest of the transport
 * like one that never committed: no user turn is reported, no speaking edge is
 * closed by hand. That is deliberate rather than an omission — an utterance
 * the recognizer could not make out is the same event as a barge-in that
 * commits nothing, so the false-interruption machinery should see it that way
 * and resume an interrupted reply if one is waiting. The CLARIFY arm is the
 * exception it has to be: it takes the floor itself, so it clears the latch
 * that would otherwise fire a continuation on top of the clarification.
 *
 * @internal
 */
export function createLowConfidenceGate(deps: {
  policy: ResolvedLowConfidence | undefined;
  log: Logger;
  sid: string;
  /** Retire a speculation built on an utterance that is not becoming a turn. */
  retireSpeculation: () => void;
  /** Drop an armed false-interruption resume — only the clarify arm does. */
  clearRecovery: () => void;
  /** Close the speaking edge, as a committed turn would. */
  endSpeech: () => void;
  /** Speak one sentence on the transport's own behalf, running no turn. */
  speakClarification: (text: string) => void;
}): LowConfidenceGate | undefined {
  const { policy } = deps;
  if (policy === undefined) return;
  return {
    classify(text, meta) {
      const verdict = classifyConfidence(confidenceFor(meta, policy), policy);
      if (verdict.kind === "accept") return;
      deps.log.info("Pipeline low-confidence transcript", {
        sid: deps.sid,
        action: verdict.kind,
        confidence: verdict.confidence,
        statistic: policy.statistic,
        text,
      });
      if (verdict.kind === "note") return { note: verdict.note };
      deps.retireSpeculation();
      if (verdict.kind === "clarify" && verdict.phrase.length > 0) {
        deps.clearRecovery();
        deps.endSpeech();
        deps.speakClarification(verdict.phrase);
      }
      return "handled";
    },
  };
}

/**
 * The MODEL's copy of a committed transcript: the caller's words, plus any
 * annotation this turn earned.
 *
 * The CLIENT's copy and both history views stay verbatim, because what the
 * caller said is not ours to rewrite — a spelling run read wrong must not be
 * able to destroy the record of it, and neither must our own doubt about the
 * words. `assembleSpelledRuns` has the measurement behind the first
 * annotation; the second is `lowConfidence`'s note.
 *
 * @internal
 */
export function modelTranscript(text: string, note: string | undefined): string {
  const spelled = assembleSpelledRuns(text);
  const annotations = [
    ...(spelled.length > 0 ? [`spelled aloud: ${spelled.join(", ")}`] : []),
    ...(note === undefined ? [] : [note]),
  ];
  if (annotations.length === 0) return text;
  return `${text}\n${annotations.map((one) => `[${one}]`).join("\n")}`;
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
 *
 * @internal
 */
export function createClarificationSpeaker(deps: {
  chain: (run: () => Promise<void>) => void;
  runReply: (idPrefix: string, body: () => Promise<boolean>) => Promise<void>;
  callbacks: Pick<TransportCallbacks, "report">;
  sendTtsText: SendTtsText;
  onCrash: (error: unknown) => void;
}): (text: string) => void {
  return (text) => {
    deps.chain(() =>
      deps
        .runReply("pipeline-clarify", async () => {
          deps.callbacks.report({
            type: "agent-transcript.committed",
            text,
            recovery: "low-confidence",
          });
          deps.sendTtsText(text, { publishTranscript: false });
          return true;
        })
        .catch(deps.onCrash),
    );
  };
}
