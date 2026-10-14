// Copyright 2026 the AAI authors. MIT license.
/**
 * DTMF key presses as agent audio — the runtime's half of `sendDtmf(ctx, keys)`.
 *
 * **In-band, and that is the whole design.** Neither shipped carrier takes a
 * key press over its media stream (Twilio Media Streams has no outbound DTMF
 * frame; Telnyx's is a separate Call Control request), and both pass agent
 * audio to a G.711 line untouched, where every phone menu decodes the standard
 * tone pairs. So a key press is PCM16 at the session's TTS rate, handed to the
 * same paced sink the agent's voice goes through: it plays after the speech
 * already queued, the telephony bridge resamples and μ-law-encodes it like any
 * other frame, and a browser session hears it too. Nothing below the sink and
 * nothing in the bridge knows tones exist.
 *
 * The tones are ITU-T Q.23 pairs at Q.24's timing with margin: 120 ms on, 80 ms
 * off (receivers must accept 40 ms of each), each tone about 10 dB under full
 * scale with the high group 2 dB hotter (the "twist" receivers expect), and a
 * short ramp at both ends so a tone starts and stops without a click a
 * receiver could read as a second press.
 */

import type { DtmfSender } from "@alexkroman1/aai/host-internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { pcm16ToBytes } from "../_pcm.ts";

/** How long each key's tone pair sounds. */
export const DTMF_TONE_MS = 120;
/** Silence after each key, so two presses of one key read as two. */
export const DTMF_GAP_MS = 80;
/** What a `w` in the keys waits — Twilio's `sendDigits` meaning. */
export const DTMF_PAUSE_MS = 500;
/** Size of each audio frame handed to the sink, as the TTS path's frames are. */
const FRAME_MS = 20;
/** Fade in and out at each end of a tone. */
const RAMP_MS = 5;
/** Peak of the low-group tone, as a fraction of full scale (~ -12 dBFS). */
const LOW_AMPLITUDE = 0.25;
/** Peak of the high-group tone: 2 dB over the low one. */
const HIGH_AMPLITUDE = 0.315;

/** The keypad's row (low group) and column (high group) frequencies. */
const ROW_HZ = [697, 770, 852, 941] as const;
const COL_HZ = [1209, 1336, 1477, 1633] as const;
const KEYPAD = ["123A", "456B", "789C", "*0#D"] as const;

/** Each key's [low, high] pair, read off {@link KEYPAD}. */
const KEY_HZ: ReadonlyMap<string, readonly [number, number]> = new Map(
  KEYPAD.flatMap((row, r) =>
    [...row].map((key, c) => [key, [ROW_HZ[r] ?? 0, COL_HZ[c] ?? 0] as const] as const),
  ),
);

/** Samples in `ms` at `sampleRate`. */
function samplesIn(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

/** Write one key's tone pair into `out` at `offset`. */
function writeTone(out: Int16Array, offset: number, hz: readonly [number, number], rate: number) {
  const length = samplesIn(DTMF_TONE_MS, rate);
  const ramp = samplesIn(RAMP_MS, rate);
  const [low, high] = hz;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const edge = Math.min(1, i / ramp, (length - 1 - i) / ramp);
    const sample =
      LOW_AMPLITUDE * Math.sin(2 * Math.PI * low * t) +
      HIGH_AMPLITUDE * Math.sin(2 * Math.PI * high * t);
    out[offset + i] = Math.round(sample * edge * 32_767);
  }
}

/**
 * The tones for `keys` as PCM16 mono at `sampleRate`, each key's pair followed
 * by its gap, `w` as {@link DTMF_PAUSE_MS} of silence. A character with no
 * tone is skipped — `sendDtmf` has already refused one, so here it can only be
 * a caller of this function that did not ask.
 */
export function dtmfTones(keys: string, sampleRate: number): Int16Array {
  const toneLength = samplesIn(DTMF_TONE_MS, sampleRate);
  const keyLength = toneLength + samplesIn(DTMF_GAP_MS, sampleRate);
  const pauseLength = samplesIn(DTMF_PAUSE_MS, sampleRate);
  let total = 0;
  for (const key of keys) {
    if (key === "w") total += pauseLength;
    else if (KEY_HZ.has(key)) total += keyLength;
  }
  const out = new Int16Array(total);
  let offset = 0;
  for (const key of keys) {
    if (key === "w") {
      offset += pauseLength;
      continue;
    }
    const hz = KEY_HZ.get(key);
    if (hz === undefined) continue;
    writeTone(out, offset, hz, sampleRate);
    offset += keyLength;
  }
  return out;
}

/**
 * {@link dtmfTones} cut into {@link FRAME_MS} frames of PCM16 LE bytes — what a
 * `ClientSink.playAudioChunk` takes, sized like the TTS frames around them so
 * the pacer meters them the same way.
 */
export function dtmfFrames(keys: string, sampleRate: number): Uint8Array[] {
  const pcm = dtmfTones(keys, sampleRate);
  const frame = Math.max(1, samplesIn(FRAME_MS, sampleRate));
  const frames: Uint8Array[] = [];
  for (let start = 0; start < pcm.length; start += frame) {
    frames.push(pcm16ToBytes(pcm.slice(start, start + frame)));
  }
  return frames;
}

/**
 * What `attach.ts` registers for one session: each press becomes frames on
 * `client` — the PACED sink, so the tones queue behind speech already sent and
 * a barge-in drops the ones not yet played, exactly as it does a reply's audio.
 */
export function dtmfSender(client: ClientSink, sampleRate: number): DtmfSender {
  return (keys) => {
    if (!client.open) return;
    for (const frame of dtmfFrames(keys, sampleRate)) client.playAudioChunk(frame);
  };
}
