// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the ffprobe JSON reader.
 *
 * Every input here is real ffprobe output (trimmed to the fields the parser
 * reads), because the whole class of bug this covers is a field whose SHAPE is
 * not what a reader assumes: a duration that is the string `"12.5"`, a
 * `sample_rate` that is `"44100"`, and a duration that is the string `"N/A"`
 * for a file ffprobe could not measure.
 */

import { describe, expect, test } from "vitest";
import { parseProbeJson } from "./_ffmpeg-json.ts";

/** `ffprobe -print_format json -show_format -show_streams` over a 16 kHz mono WAV. */
const WAV = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_name: "pcm_s16le",
      codec_type: "audio",
      sample_fmt: "s16",
      sample_rate: "16000",
      channels: 1,
      bits_per_sample: 16,
      duration: "3.500000",
    },
  ],
  format: {
    filename: "/tmp/speech.wav",
    format_name: "wav",
    duration: "3.500000",
    size: "112044",
    bit_rate: "256102",
  },
});

describe("parseProbeJson", () => {
  test("reads the numbers ffprobe prints as strings", () => {
    const info = parseProbeJson(WAV);
    expect(info).toMatchObject({
      durationSec: 3.5,
      format: "wav",
      sizeBytes: 112_044,
      bitRate: 256_102,
    });
    expect(info.audio).toMatchObject({
      index: 0,
      kind: "audio",
      codec: "pcm_s16le",
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "s16",
    });
  });

  test("picks the first audio and video stream out of a container", () => {
    const info = parseProbeJson(
      JSON.stringify({
        streams: [
          { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
          { index: 1, codec_type: "audio", codec_name: "aac" },
          { index: 2, codec_type: "audio", codec_name: "ac3" },
          { index: 3, codec_type: "subtitle", codec_name: "mov_text" },
        ],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      }),
    );
    expect(info.streams).toHaveLength(4);
    expect(info.video).toMatchObject({ codec: "h264", width: 1920, height: 1080 });
    // The FIRST audio stream, which is what a pipeline reading `.audio` means —
    // a film's second track is a commentary, not the dialogue.
    expect(info.audio?.codec).toBe("aac");
  });

  /**
   * `"N/A"` is ffprobe's answer for a duration it could not determine — a
   * stream from a pipe, a truncated download. It must read as ABSENT: a caller
   * that gets `NaN` computes a segment count of `NaN`, and one that gets `0`
   * plans zero segments and transcribes silence.
   */
  test("treats N/A and empty strings as absent, never as NaN or zero", () => {
    const info = parseProbeJson(
      JSON.stringify({
        streams: [{ index: 0, codec_type: "audio", codec_name: "", sample_rate: "N/A" }],
        format: { format_name: "wav", duration: "N/A", size: "" },
      }),
    );
    expect(info.durationSec).toBeUndefined();
    expect(info.sizeBytes).toBeUndefined();
    expect(info.audio?.sampleRate).toBeUndefined();
    expect(info.audio?.codec).toBeUndefined();
    // Absent, not present-and-undefined: `exactOptionalPropertyTypes` is what
    // makes that distinction worth asserting.
    expect("durationSec" in info).toBe(false);
  });

  /**
   * A duration lives on the FORMAT for a well-formed file and on a STREAM for
   * one written without a container-level header. A caller asking "how long is
   * this" should not have to know which of ffprobe's two places recorded it.
   */
  test("falls back to a stream's duration when the format has none", () => {
    const info = parseProbeJson(
      JSON.stringify({
        streams: [{ index: 0, codec_type: "audio", duration: "42.25" }],
        format: { format_name: "aac", duration: "N/A" },
      }),
    );
    expect(info.durationSec).toBe(42.25);
  });

  test("survives shapes it did not expect rather than failing the step", () => {
    // ffprobe's `-v error` plus a zero exit is the contract that the JSON is
    // complete; past that, a step reporting what it read beats a step dying on
    // an unusual container.
    for (const json of ['{"format":"not an object"}', "{}", '{"streams":null}', "[]"]) {
      const info = parseProbeJson(json);
      expect.soft(info.streams, json).toEqual([]);
      expect.soft(info.durationSec, json).toBeUndefined();
    }
  });

  test("indexes a stream by position when ffprobe omitted its index", () => {
    const info = parseProbeJson(JSON.stringify({ streams: [{ codec_type: "audio" }, null] }));
    expect(info.streams.map((s) => s.index)).toEqual([0, 1]);
    // A stream with no `codec_type` at all is still a stream; naming it
    // "unknown" keeps `.streams` a faithful list of what the container holds.
    expect(info.streams[1]?.kind).toBe("unknown");
  });

  test("keeps the parsed JSON for a field this type does not name", () => {
    const info = parseProbeJson(WAV);
    expect(info.raw).toMatchObject({ format: { filename: "/tmp/speech.wav" } });
  });

  // The one throwing case, deliberately: malformed JSON is a broken invocation
  // (the wrong flags, a banner that leaked into stdout), not an unusual file.
  test("throws on output that is not JSON at all", () => {
    expect(() => parseProbeJson("ffmpeg version 7.1.1\n")).toThrow(SyntaxError);
  });
});
