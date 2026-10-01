// Copyright 2026 the AAI authors. MIT license.
/**
 * `metrics.collected` for the two S2S transports — the `turnMetrics`
 * capability, one adapter both wrap their callbacks in.
 *
 * ## What an S2S service lets the host time
 *
 * The service runs STT, the model and TTS inside one socket and reports none of
 * the boundaries between them, so the stages the pipeline fills in
 * (`pipeline/turn/metrics.ts`) — `stt.endpointingMs`, `llm`, `tts` — stay
 * ABSENT here, never zero (a zero averages in as the fast case). What the host
 * DOES see is the whole round trip at the edges it already reports:
 *
 * - `speech.stopped` — the service's own end-of-speech, the S2S counterpart of
 *   the pipeline's committed final. The transcript (`userTranscript.committed`)
 *   is no mark: it can land after the reply has already started speaking.
 * - `onReplyStarted` → the first `onAudioChunk` → `reply.completed` /
 *   `reply.cancelled`.
 *
 * So one frame per settled reply carries `interrupted` and, when a caller's
 * turn started it and it spoke, `latencyMs` from end-of-speech to first audio.
 *
 * ## Which reply a turn belongs to
 *
 * The first reply to deliver AUDIO after an end-of-speech claims it — not the
 * first to start. An S2S service answers a tool-using turn with several
 * provider replies, and the one carrying `tool.call` is silent; claiming at
 * reply start would hand the mark to that reply and report no latency for the
 * turn the caller actually waited on. Claiming at audio measures what the
 * caller heard: end-of-speech to the agent's first sound, tool time included.
 * A reply that claims nothing (a greeting, a second spoken reply of the same
 * turn) reports no latency — "absent when no caller turn started it". The
 * caller speaking again before any audio supersedes the mark: that utterance
 * did not end yet.
 *
 * ## Adapters only translate
 *
 * This wraps a {@link TransportCallbacks}: every call is forwarded untouched
 * first, and the frame is reported AFTER the settling event, the order the
 * pipeline transport reports in. No timers and no async — a clock read per
 * edge, on a path (each audio chunk) that runs many times a second.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { TransportCallbacks, TransportEventBody } from "./types.ts";

type OpenReply = { latencyMs?: number | undefined; spoke: boolean };

const whole = (n: number): number => Math.max(0, Math.round(n));

/**
 * Wrap an S2S transport's callbacks so each settled reply also reports its
 * `metrics.collected` frame — see this module's doc.
 *
 * @internal
 */
export function withS2sTurnMetrics(
  callbacks: TransportCallbacks,
  now: () => number = Date.now,
): TransportCallbacks {
  // The caller's most recent end-of-speech that no reply has claimed yet.
  let endOfSpeechAt: number | undefined;
  let open: OpenReply | undefined;

  function finish(interrupted: boolean): void {
    const reply = open;
    open = undefined;
    if (!reply) return;
    callbacks.report({
      type: "metrics.collected",
      interrupted,
      ...omitUndefined({ latencyMs: reply.latencyMs }),
    });
  }

  function observe(event: TransportEventBody): void {
    switch (event.type) {
      case "speech.started":
        endOfSpeechAt = undefined;
        break;
      case "speech.stopped":
        endOfSpeechAt = now();
        break;
      case "reply.completed":
        finish(false);
        break;
      case "reply.cancelled":
        finish(true);
        break;
      default:
        break;
    }
  }

  return {
    report(event) {
      callbacks.report(event);
      observe(event);
    },
    onAudioChunk(bytes) {
      callbacks.onAudioChunk(bytes);
      if (!open || open.spoke) return;
      open.spoke = true;
      if (endOfSpeechAt === undefined) return;
      open.latencyMs = whole(now() - endOfSpeechAt);
      endOfSpeechAt = undefined;
    },
    onReplyStarted(replyId) {
      // A reply that never settled before the next one started was cut short.
      finish(true);
      open = { spoke: false };
      callbacks.onReplyStarted(replyId);
    },
  };
}
