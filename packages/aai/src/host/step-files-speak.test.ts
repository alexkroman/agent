// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `stepSpeakToUpload`: the WAV path touches no subprocess, the MP3
 * path masters through a fake ffmpeg child (the `ffmpegProcess.spawn` seam
 * `ffmpeg.test.ts` uses) and stores what it wrote, and a failed encode leaves
 * the store empty with a fatal verdict.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { FatalError } from "../sdk/step-error-classes.ts";
import { STUB_SPEECH_PCM_BYTES } from "../sdk/testing-speech.ts";
import { installStubSpeech, installStubUploads } from "../sdk/testing-vitest.ts";
import { WAV_HEADER_BYTES } from "../sdk/wav.ts";
import { ffmpegProcess } from "./_ffmpeg-spawn.ts";
import { type SpeakMasterFormat, stepSpeakToUpload } from "./step-files-speak.ts";

const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

/**
 * A fake ffmpeg that records its argv and the bytes at `-i`, writes `MP3` to the
 * last argument, and exits `code` on the next macrotask.
 */
function installFakeFfmpeg(
  code = 0,
  output: Uint8Array = MP3,
): { args: string[]; input: Uint8Array | undefined }[] {
  const spawned: { args: string[]; input: Uint8Array | undefined }[] = [];
  vi.spyOn(ffmpegProcess, "spawn").mockImplementation((_binary, args) => {
    let close: ((c: number | null, s: string | null) => void) | undefined;
    const source = args[args.indexOf("-i") + 1];
    spawned.push({
      args,
      input: source && existsSync(source) ? new Uint8Array(readFileSync(source)) : undefined,
    });
    setTimeout(() => {
      const out = args.at(-1);
      if (code === 0 && out) writeFileSync(out, output);
      close?.(code, null);
    }, 0);
    const silent = { on: () => undefined };
    return {
      stdout: silent,
      stderr: silent,
      stdin: null,
      on(event: string, cb: (...payload: never[]) => void) {
        if (event === "close") close = cb as typeof close;
        return this;
      },
      kill: () => undefined,
    };
  });
  return spawned;
}

describe("stepSpeakToUpload", () => {
  test("refuses an unknown master format by name, before speaking — as a string or in the object form", async () => {
    const speech = installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });
    const spawn = vi.spyOn(ffmpegProcess, "spawn");
    // The type refuses these; a JS author or a cast reaches them, and what they
    // reached was a stored `type: ""` and `… is not iterable`.
    const bad: SpeakMasterFormat = JSON.parse('"ogg"');
    await expect(stepSpeakToUpload("hi", { master: bad, name: "x.ogg" })).rejects.toThrow(
      /unknown master format "ogg"; known formats: wav, mp3/,
    );
    await expect(
      stepSpeakToUpload("hi", { master: { format: bad, args: ["-ac", "1"] }, name: "x.ogg" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(speech.calls).toEqual([]);
    expect(uploads.writes).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("stores the spoken WAV under the name given, with no subprocess", async () => {
    const speech = installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });
    const spawn = vi.spyOn(ffmpegProcess, "spawn");

    const stored = await stepSpeakToUpload("Three findings.", {
      voice: "aai-vera",
      name: "digest.wav",
    });

    expect(stored).toMatchObject({
      id: "upl_stub_1",
      name: "digest.wav",
      label: "digest.wav",
      type: "audio/wav",
      size: WAV_HEADER_BYTES + STUB_SPEECH_PCM_BYTES,
      complete: true,
      voice: "aai-vera",
    });
    // The stub's PCM at 24 kHz PCM16: 12 000 bytes is a quarter second.
    expect(stored.durationMs).toBe(250);
    expect(speech.calls.map((call) => call.text)).toEqual(["Three findings."]);
    expect(uploads.writes.map((one) => one.type)).toEqual(["audio/wav"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('`master: "mp3"` encodes the WAV with libmp3lame and stores the MP3', async () => {
    installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });
    const spawned = installFakeFfmpeg();

    const stored = await stepSpeakToUpload("Three findings.", {
      master: "mp3",
      name: "digest.mp3",
    });

    expect(spawned).toHaveLength(1);
    // The encoder read the WAV `stepSpeak` made — header plus the stub's PCM.
    expect(spawned[0]?.input?.length).toBe(WAV_HEADER_BYTES + STUB_SPEECH_PCM_BYTES);
    expect(spawned[0]?.args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-nostdin",
      "-y",
      "-i",
      expect.stringMatching(/\/spoken\.wav$/),
      "-vn",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      expect.stringMatching(/\/mastered\.mp3$/),
    ]);
    expect(stored).toMatchObject({ name: "digest.mp3", type: "audio/mpeg", size: MP3.length });
    expect(stored.durationMs).toBe(250);
    expect(stored.ffmpegMs).toEqual(expect.any(Number));
    expect(uploads.writes.map((one) => [one.type, [...one.bytes]])).toEqual([
      ["audio/mpeg", [...MP3]],
    ]);
    // And the temp directory is gone.
    expect(existsSync(spawned[0]?.args.at(-1) ?? "")).toBe(false);
  });

  test("the object form rides its flags on the master leg, ahead of the encoder's", async () => {
    installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });
    const spawned = installFakeFfmpeg();

    const stored = await stepSpeakToUpload("Three findings.", {
      master: { format: "mp3", args: ["-af", "loudnorm=I=-16"] },
      name: "digest.mp3",
    });

    expect(spawned[0]?.args.slice(6)).toEqual([
      "-i",
      expect.stringMatching(/\/spoken\.wav$/),
      "-vn",
      "-af",
      "loudnorm=I=-16",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      expect.stringMatching(/\/mastered\.mp3$/),
    ]);
    expect(stored.type).toBe("audio/mpeg");
    expect(uploads.writes).toHaveLength(1);
  });

  test('`{ format: "wav", args }` re-encodes the WAV through ffmpeg; a bare "wav" never spawns', async () => {
    installStubSpeech();
    installStubUploads({}, { writable: true });
    const spawned = installFakeFfmpeg();

    const stored = await stepSpeakToUpload("Three findings.", {
      master: { format: "wav", args: ["-ar", "8000"] },
      name: "digest.wav",
    });

    expect(spawned[0]?.args.slice(6)).toEqual([
      "-i",
      expect.stringMatching(/\/spoken\.wav$/),
      "-vn",
      "-ar",
      "8000",
      expect.stringMatching(/\/mastered\.wav$/),
    ]);
    expect(stored.type).toBe("audio/wav");
    expect(stored.ffmpegMs).toEqual(expect.any(Number));

    const plain = await stepSpeakToUpload("Three findings.", {
      master: { format: "wav" },
      name: "p.wav",
    });
    expect(spawned).toHaveLength(1);
    expect(plain.ffmpegMs).toBe(0);
  });

  test("an encode that wrote nothing is FATAL and stores nothing — the rule the transcode leg has", async () => {
    installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });
    installFakeFfmpeg(0, new Uint8Array(0));

    const err = await stepSpeakToUpload("Three findings.", {
      master: "mp3",
      name: "digest.mp3",
    }).catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toContain("empty digest.mp3 for the spoken audio");
    expect(uploads.writes).toEqual([]);
  });

  test("a failed encode is FATAL and stores nothing", async () => {
    installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });
    installFakeFfmpeg(1);

    await expect(
      stepSpeakToUpload("Three findings.", { master: "mp3", name: "digest.mp3" }),
    ).rejects.toSatisfy(FatalError.is);
    expect(uploads.writes).toEqual([]);
  });

  test("refuses blank text before speaking or storing anything", async () => {
    const speech = installStubSpeech();
    const uploads = installStubUploads({}, { writable: true });

    await expect(stepSpeakToUpload("   ", { name: "digest.wav" })).rejects.toThrow(
      /nothing to say/,
    );
    expect(speech.calls).toEqual([]);
    expect(uploads.writes).toEqual([]);
  });
});
