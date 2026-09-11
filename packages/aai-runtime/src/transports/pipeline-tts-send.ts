// Copyright 2026 the AAI authors. MIT license.
/**
 * The session's raw TTS send — the funnel every spoken word in pipeline mode
 * goes through before the output guardrail wraps it (`createSpeechGate`).
 *
 * Split out of `pipeline-transport.ts` at the 500-line cap, on the seam that
 * file already had: this is four concerns that travel together and nothing
 * else in the transport reads any of them — opening the audio gate for the
 * turn, ASCII-folding for the engine, advancing the heard cursor, and
 * publishing the interim caption. The `TTS first audio` measurement comes with
 * them, because the timestamp it subtracts from is set HERE and was read by a
 * provider handler two hundred lines away.
 */

import { normalizeSpeechText } from "@alexkroman1/aai/internal";
import type { Logger } from "../runtime-config.ts";
import type { HeardTracker } from "./pipeline-heard.ts";
import type { TurnMachine } from "./pipeline-turn-state.ts";
import type { SendTtsOptions, TransportCallbacks } from "./types.ts";

/** What {@link createTtsSender} needs from the transport around it. */
export type TtsSenderDeps = {
  turns: TurnMachine;
  heard: HeardTracker;
  /** Read per send: the TTS session is replaced across a provider recovery. */
  tts: () => { sendText(text: string): void } | null;
  callbacks: Pick<TransportCallbacks, "report">;
  log: Logger;
  sid: string;
};

/** The raw send plus the one measurement that reads its clock. */
export type TtsSender = {
  /**
   * Forward turn text to TTS, reopening the audio gate for the new turn.
   *
   * Publishing here rather than at reply end keeps captions with the audio — a
   * tool chain speaks filler long before the answer exists. `publishTranscript:
   * false` skips it for the greeting/start-failure lines, which publish their
   * own final. The tail advances either way: it feeds the tail-resume estimate.
   */
  send(text: string, opts?: SendTtsOptions): void;
  /**
   * The turn's first audio chunk arrived — log the text→audio term if this
   * send is the one being timed.
   *
   * The measurement, rather than the inference it replaced: it had only ever
   * been a subtraction (endpointing + `firstPartMs` against the reply the
   * caller heard), which put it at 0.7-1.8s; measured directly it is ~66ms, so
   * synthesis is not where a voice turn's latency lives. Cleared as soon as it
   * fires, so a reply streamed as several sentences is timed from its first.
   */
  reportFirstAudio(): void;
};

export function createTtsSender(deps: TtsSenderDeps): TtsSender {
  const { turns, heard, tts, callbacks, log, sid } = deps;
  let ttsTextAtMs: number | undefined;
  return {
    send(text, opts) {
      turns.openAudioGate();
      ttsTextAtMs ??= Date.now();
      // ASCII-fold typographic quotes for the engine; length-preserving, so the
      // heard cursor below still indexes the same positions (normalizeSpeechText).
      tts()?.sendText(normalizeSpeechText(text));
      const tail = heard.onText(text, opts?.record !== false);
      if (opts?.publishTranscript !== false)
        callbacks.report({ type: "agent-transcript.updated", text: tail });
    },
    reportFirstAudio() {
      if (ttsTextAtMs === undefined) return;
      log.info("TTS first audio", { sid, afterTextMs: Date.now() - ttsTextAtMs });
      ttsTextAtMs = undefined;
    },
  };
}
