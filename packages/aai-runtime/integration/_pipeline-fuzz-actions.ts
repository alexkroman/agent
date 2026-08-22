// Copyright 2026 the AAI authors. MIT license.
/**
 * What a generated step DOES to the pipeline transport under test.
 *
 * Third member of the `_pipeline-fuzz-*` family, split out on the seam the
 * suite already had: `_pipeline-fuzz-input.ts` generates the world,
 * `_pipeline-fuzz-model.ts` owns the monitor and the streaming oracles, this
 * owns the action table, `_pipeline-fuzz-run.ts` owns one run, and the
 * `.integration.test.ts` file owns the PROPERTIES and their coverage floors.
 * The argument for the whole suite stays in that test file's module doc, which
 * is where a reader looks for it.
 *
 * Every action here is something a REAL session does — that is the contract a
 * generator owes (see the root guide's "A generator must not break its own
 * contract"), and two of these check the live synthesis window before emitting
 * audio precisely to keep it.
 */

import type { FakeSttProvider, FakeTtsProvider } from "../_pipeline-test-fakes.ts";
import type { createPipelineTransport } from "../transports/pipeline-transport.ts";
import type { ActionKind } from "./_pipeline-fuzz-input.ts";
import type { Monitor } from "./_pipeline-fuzz-model.ts";

/**
 * The events a generated step can fire, keyed by action.
 *
 * `reset` is a no-op in a long session: it clears history, so a long run that
 * reset could never reach the cap its runs exist to exercise.
 */
export function buildActions(
  mon: Monitor,
  deps: {
    stt: FakeSttProvider;
    tts: FakeTtsProvider;
    transport: ReturnType<typeof createPipelineTransport>;
    utterance: (opener: number) => string;
    longSession: boolean;
    armBargeInFromTool: () => void;
    /**
     * The text a `highConfidencePartial` last spoke, so the NEXT `sttFinal`
     * commits the same words. Without it every final revises its partial and the
     * match rule discards 100% of speculations — the adoption path would be
     * generated and never entered.
     */
    speculated: { text: string | null };
    /** Does the step being dispatched pause afterwards? See highConfidencePartial. */
    lastPauseWasNull(): boolean;
  },
): Record<ActionKind, (opener: number) => void> {
  const { stt, tts, transport, utterance, speculated, lastPauseWasNull } = deps;
  return {
    sttPartial: (opener) => stt.last()?.firePartial(utterance(opener)),
    sttFinal: (opener) => {
      const text = speculated.text ?? utterance(opener);
      speculated.text = null;
      stt.last()?.fireFinal(text);
    },
    // A confident interim — what a real STT emits as an utterance completes
    // (`SttTurnMeta.endOfTurnConfidence`); 1 clears the threshold however it is
    // retuned. Biased toward the speculating state the way `armBargeInFromTool`
    // is biased toward a barge-in inside a tool call, and everything it fires is
    // something a real session does.
    //
    // The two shapes it has to reach are opposite, so the step's OWN generated
    // pause chooses between them — no extra field, and it reads the way the
    // audio does. No pause at all means the caller stopped dead on that word, so
    // the final lands with it and the speculation is ADOPTED (zero head start,
    // which is the harder path: the tape is claimed before its request has even
    // been issued). A pause means the utterance is still open, so the text is
    // handed to the next `sttFinal` and the speculation has to survive whatever
    // the walk does in between — usually nothing, because at this suite's 1 ms
    // `speechIdleTimeoutMs` the watchdog reaps it, which is the DISCARD side.
    highConfidencePartial: (opener) => {
      const text = utterance(opener);
      stt.last()?.firePartial(text, { endOfTurnConfidence: 1 });
      if (lastPauseWasNull()) stt.last()?.fireFinal(text);
      else speculated.text = text;
    },
    ttsAudio: () => {
      // A real TTS provider emits audio only while a turn's synthesis is in
      // flight, never after signalling `done` for it (TtsEvents in
      // sdk/providers.ts). Outside that window this would trip the truncation
      // oracle on the generator's own contract violation.
      if (mon.current === null || mon.current.done) {
        mon.hit("audioSuppressedOutsideTurn");
        return;
      }
      tts.last()?.fireAudio(new Int16Array(2400));
    },
    cancelReply: () => {
      mon.disturb();
      transport.cancelReply();
    },
    reset: () => {
      if (deps.longSession) return;
      mon.disturb();
      // Optional on Transport (S2S has no conversation state of its own).
      transport.reset?.();
    },
    sendUserAudio: () => transport.sendUserAudio(new Uint8Array(320)),
    armBargeInFromTool: () => deps.armBargeInFromTool(),
    // Bias toward FALSE-INTERRUPTION RECOVERY, the way `armBargeInFromTool`
    // biases toward a barge-in inside a tool call. A uniform walk reaches it
    // almost never: the shape needs a partial to land while the agent is
    // AUDIBLY speaking (measured: 8 such barge-ins in a whole property run,
    // of which 1 resumed), then a quiet transcript stream with no final ever
    // arriving. This composes it — audio for the live turn, then a noise
    // partial — and `runOne`'s step loop supplies the quiet gap. Every part of
    // it is something a real session does; nothing here is illegal for a
    // provider to emit.
    noiseBargeIn: () => {
      // Same contract as `ttsAudio`: a real provider emits no audio outside a
      // turn's synthesis window.
      if (mon.current !== null && !mon.current.done) tts.last()?.fireAudio(new Int16Array(2400));
      stt.last()?.firePartial("uh what");
    },
  };
}
