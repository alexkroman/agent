// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything between a reply and the caller's ear, in one module.
 *
 * Three things used to sit loose in `pipeline-transport.ts` and are one path:
 * the funnel text goes OUT through (`sendTtsText`, guardrail-wrapped), the two
 * handlers audio and word timings come BACK through, and the speak gate that
 * may hold both. Collecting them is what made the transport fit under the
 * source-length cap again, but the reason to keep them together is that each
 * of the three has an ordering rule about the other two:
 *
 * - **`sendTtsText` opens the turn's audio gate**, so the handlers cannot fire
 *   for a turn that has sent no text.
 * - **The handlers are gated TWICE** — the turn's own audio gate (a cancelled
 *   turn's late frames), then the speak gate (a floor or backoff window). The
 *   turn gate is re-checked at flush time, because a barge-in inside the
 *   window must not release audio that is no longer wanted.
 * - **Audio and word timings share ONE queue.** The timings index into the
 *   audio stream, so one held and the other not would hand the heard cursor
 *   timings for audio the caller has not been sent.
 *
 * What is NOT here is the decision to hold: `armFloor` is called when a reply
 * starts and `onInterrupted` when a barge-in fires, both from the transport,
 * which is where a turn's lifecycle lives.
 */

import type { TtsWordTiming } from "@alexkroman1/aai/host-internal";
import { normalizeSpeechText } from "@alexkroman1/aai/internal";
import { pcm16ToBytes } from "../_pcm.ts";
import type { Logger } from "../runtime-config.ts";
import { createSpeechGate, type SpeechGate, type TurnGuardrails } from "./pipeline-guardrails.ts";
import type { HeardTracker } from "./pipeline-heard.ts";
import { createSpeakGate } from "./pipeline-speak-gate.ts";
import type { TurnMachine } from "./pipeline-turn-state.ts";
import type { SendTtsOptions, TransportCallbacks } from "./types.ts";

export interface AudioOut {
  /**
   * The funnel every collaborator is handed — the raw send when this session
   * declares no output guardrail, and a HOLDABLE wrapper around it when it
   * does. Wrapping here rather than at each call site is what makes "one place
   * all speech goes through" true of the hold as well as of the send.
   */
  speech: SpeechGate;
  /** `speech.send`, for the callers that only ever send. */
  sendTtsText: (text: string, opts?: SendTtsOptions) => void;
  /** One PCM16 chunk of the current reply's TTS audio. */
  onTtsAudio(pcm: Int16Array): void;
  /** Word timings for this reply's audio, already rebased by the adapter. */
  onTtsWords(words: readonly TtsWordTiming[]): void;
  /** A reply is starting: arm the start-speaking floor. */
  armFloor(): void;
  /** A real interruption fired: arm the post-interruption backoff. */
  onInterrupted(): void;
  /** A turn was aborted: discard anything still held for it. */
  drop(): void;
  /** Session teardown: clear the pending flush timer. */
  stop(): void;
}

export function createAudioOut(deps: {
  /** Minimum ms between a reply starting and its first audio out; 0 disables. */
  startSpeakingFloorMs: number;
  /** Ms of blocked audio after a real interruption; 0 disables. */
  interruptionBackoffMs: number;
  /** Clock source for the gate — the transport's test seam. */
  now?: (() => number) | undefined;
  turns: TurnMachine;
  heard: HeardTracker;
  /** The TTS session, LAZILY: it is opened after this is built, and re-opened on a reconnect. */
  tts: () => { sendText(text: string): void } | null | undefined;
  callbacks: Pick<TransportCallbacks, "report" | "onAudioChunk">;
  /** This session's output guardrail, or the no-op set. */
  guardrails: TurnGuardrails;
  log: Logger;
  sid: string;
}): AudioOut {
  const { turns, heard, callbacks, log } = deps;

  const speakGate = createSpeakGate({
    startSpeakingFloorMs: deps.startSpeakingFloorMs,
    interruptionBackoffMs: deps.interruptionBackoffMs,
    now: deps.now,
    log,
    sid: deps.sid,
  });

  /**
   * When this turn's FIRST text went to TTS, for the `TTS first audio`
   * measurement below. Cleared as soon as that turn's audio arrives, so a
   * reply streamed as several sentences is timed from its first one rather
   * than its latest.
   */
  let ttsTextAtMs: number | undefined;

  /**
   * Forward turn text to TTS, reopening the audio gate for the new turn.
   *
   * Publishing the interim caption here rather than at reply end keeps
   * captions with the audio — a tool chain speaks filler long before the
   * answer exists. `publishTranscript: false` skips it for the
   * greeting/start-failure lines, which publish their own final. The tail
   * advances either way: it feeds the tail-resume estimate.
   */
  function sendTtsTextNow(text: string, opts?: SendTtsOptions): void {
    turns.openAudioGate();
    ttsTextAtMs ??= Date.now();
    // ASCII-fold typographic quotes for the engine; length-preserving, so the
    // heard cursor below still indexes the same positions (normalizeSpeechText).
    deps.tts()?.sendText(normalizeSpeechText(text));
    const tail = heard.onText(text, opts?.record !== false);
    if (opts?.publishTranscript !== false)
      callbacks.report({ type: "agent-transcript.updated", text: tail });
  }

  const speech = createSpeechGate(deps.guardrails.holdsSpeech, sendTtsTextNow);

  return {
    speech,
    sendTtsText: speech.send,

    onTtsAudio(pcm: Int16Array): void {
      if (!turns.audioGateOpen()) return;
      // The WHOLE body goes through the speak gate, not just the client
      // write: `heard.onAudio` starts the playback clock, so delivering the
      // bookkeeping early and the audio late would put the heard cursor ahead
      // of the caller's ear by the width of the floor.
      speakGate.deliver(() => {
        if (!turns.audioGateOpen()) return;
        // The text->audio term, measured rather than inferred. It had only
        // ever been a subtraction (endpointing + `firstPartMs` against L_R at
        // the caller's ear), which put it at 0.7-1.8s; measured directly it is
        // ~66ms, so synthesis is not where a voice turn's latency lives.
        if (ttsTextAtMs !== undefined) {
          log.info("TTS first audio", { sid: deps.sid, afterTextMs: Date.now() - ttsTextAtMs });
          ttsTextAtMs = undefined;
        }
        turns.markSpoke();
        heard.onAudio(pcm);
        callbacks.onAudioChunk(pcm16ToBytes(pcm));
      });
    },

    onTtsWords(words: readonly TtsWordTiming[]): void {
      if (!turns.audioGateOpen()) return;
      speakGate.deliver(() => {
        if (!turns.audioGateOpen()) return;
        heard.onWords(words);
      });
    },

    armFloor: () => speakGate.hold(deps.startSpeakingFloorMs),
    onInterrupted: () => speakGate.hold(deps.interruptionBackoffMs),
    drop: () => speakGate.drop(),
    stop: () => speakGate.stop(),
  };
}
