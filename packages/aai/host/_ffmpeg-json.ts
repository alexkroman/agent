// Copyright 2026 the AAI authors. MIT license.
/**
 * ffprobe's JSON, turned into something a step can read a field off.
 *
 * Split from `ffmpeg.ts` because it is the half with no process in it: given
 * the bytes ffprobe printed, this is pure. So the parsing — which is where the
 * surprises are — is covered by unit tests over recorded output rather than by
 * a suite that has to have a binary installed to run at all.
 *
 * ## Everything ffprobe prints is a STRING
 *
 * `"duration": "12.345"`, `"sample_rate": "16000"`, `"channels": 2`. The one
 * that is already a number is `channels`, and `index`, and nothing else worth
 * relying on — so every numeric field goes through {@link num}, which answers
 * `undefined` for a value that is absent, non-finite, or one of the two
 * spellings of "I don't know": `"N/A"` and `""`. A caller that treats a missing
 * duration as `0` computes a segment count of zero and transcribes silence,
 * which is exactly the shape of bug a `Number("N/A") === NaN` leaking through
 * produces three call frames later.
 *
 * Fields are otherwise passed through by NAME rather than wholesale: ffprobe's
 * stream objects carry ~40 keys apiece (disposition maps, tag dictionaries,
 * per-codec extradata), and a step wanting one of those can ask for
 * `-show_entries` itself and read {@link MediaInfo.raw}.
 */

import { isRecord } from "../sdk/is-record.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";

/** One elementary stream inside a container. */
export type MediaStreamInfo = {
  /** ffprobe's own stream index — what `-map 0:<index>` names. */
  index: number;
  /** `"audio"`, `"video"`, `"subtitle"`, `"data"`, … */
  kind: string;
  /** Decoder name, e.g. `"pcm_s16le"`, `"aac"`, `"h264"`. */
  codec?: string;
  /** Samples per second (audio). */
  sampleRate?: number;
  /** Channel count (audio). */
  channels?: number;
  /** Sample format, e.g. `"s16"`, `"fltp"` (audio). */
  sampleFormat?: string;
  /** Pixel dimensions (video). */
  width?: number;
  height?: number;
  /** Stream duration in seconds, when the container declares a per-stream one. */
  durationSec?: number;
};

/** What `parseProbeJson` makes of one media file — see `@alexkroman1/aai/ffmpeg`. */
export type MediaInfo = {
  /** Duration in seconds, or `undefined` when the container does not say. */
  durationSec?: number;
  /** ffprobe's format name(s), e.g. `"wav"`, `"mov,mp4,m4a,3gp,3g2,mj2"`. */
  format?: string;
  /** Overall bit rate in bits per second. */
  bitRate?: number;
  /** File size in bytes, as ffprobe measured it. */
  sizeBytes?: number;
  /** Every stream, in ffprobe's order. */
  streams: MediaStreamInfo[];
  /** The first audio stream — the one an audio pipeline almost always means. */
  audio?: MediaStreamInfo;
  /** The first video stream. */
  video?: MediaStreamInfo;
  /** ffprobe's parsed JSON, verbatim, for a field this type does not name. */
  raw: unknown;
};

/**
 * A numeric ffprobe field, or `undefined`.
 *
 * `"N/A"` is ffprobe's answer for a duration it could not determine (a stream
 * copy with no index, a truncated file), and an empty string appears for a tag
 * that exists but is unset. Both must read as ABSENT, never as `NaN` — a `NaN`
 * survives arithmetic silently and fails a long way from here.
 */
function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value === "" || value === "N/A") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A string ffprobe field, or `undefined` — same absent-vs-empty rule as {@link num}. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value !== "N/A" ? value : undefined;
}

function parseStream(value: unknown, fallbackIndex: number): MediaStreamInfo {
  const record = isRecord(value) ? value : {};
  return {
    index: num(record.index) ?? fallbackIndex,
    kind: str(record.codec_type) ?? "unknown",
    ...omitUndefined({
      codec: str(record.codec_name),
      sampleRate: num(record.sample_rate),
      channels: num(record.channels),
      sampleFormat: str(record.sample_fmt),
      width: num(record.width),
      height: num(record.height),
      durationSec: num(record.duration),
    }),
  };
}

/**
 * Parse `ffprobe -print_format json -show_format -show_streams` output.
 *
 * Never throws on a SHAPE it did not expect — a missing `streams` array, a
 * `format` that is a string, a stream that is `null`. ffprobe's `-v error` plus
 * a zero exit is the contract that the JSON is complete; everything past that is
 * a field this parser either finds or reports absent, because the alternative is
 * a step that dies on an unusual container instead of reporting what it read.
 * Malformed JSON is the one exception: that is a broken invocation, not an
 * unusual file, and it throws.
 */
export function parseProbeJson(json: string): MediaInfo {
  const parsed: unknown = JSON.parse(json);
  const root = isRecord(parsed) ? parsed : {};
  const format = isRecord(root.format) ? root.format : {};
  const streams = (Array.isArray(root.streams) ? root.streams : []).map(parseStream);
  return {
    streams,
    raw: parsed,
    ...omitUndefined({
      durationSec: num(format.duration) ?? firstDefined(streams, (s) => s.durationSec),
      format: str(format.format_name),
      bitRate: num(format.bit_rate),
      sizeBytes: num(format.size),
      audio: streams.find((s) => s.kind === "audio"),
      video: streams.find((s) => s.kind === "video"),
    }),
  };
}

/**
 * The first defined result of `pick` over `streams`.
 *
 * A duration lives on the FORMAT for a well-formed file and on a STREAM for one
 * written without a container-level header — a raw ADTS or a piped stream. A
 * caller reading `info.durationSec` wants "how long is this", not "which of
 * ffprobe's two places recorded it".
 */
function firstDefined<T, R>(items: readonly T[], pick: (item: T) => R | undefined): R | undefined {
  for (const item of items) {
    const value = pick(item);
    if (value !== undefined) return value;
  }
  return undefined;
}
