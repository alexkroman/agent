// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, onTestFinished, test } from "vitest";
import { publishStepEnv } from "./step-env.ts";
import { stepSpeak } from "./step-speak.ts";
import { STUB_SPEECH_PCM_BYTES, stubSpeech } from "./testing-speech.ts";
import { WAV_HEADER_BYTES } from "./wav.ts";

afterEach(() => publishStepEnv(undefined));

describe("stubSpeech", () => {
  test("records what a step asked to say, with stepSpeak's defaults filled in", async () => {
    const speech = stubSpeech();
    onTestFinished(speech.restore);
    publishStepEnv({ ASSEMBLYAI_API_KEY: "key" });

    await stepSpeak("  Three findings.  ");

    expect(speech.calls).toEqual([
      {
        text: "Three findings.",
        apiKey: "key",
        voice: "jane",
        language: undefined,
        sampleRate: 24_000,
      },
    ]);
  });

  test("answers with silence the caller can measure", async () => {
    const speech = stubSpeech();
    onTestFinished(speech.restore);
    publishStepEnv({ ASSEMBLYAI_API_KEY: "key" });

    const spoken = await stepSpeak("hello");

    expect(spoken.pcm.length).toBe(STUB_SPEECH_PCM_BYTES);
    expect(spoken.audio.length).toBe(WAV_HEADER_BYTES + STUB_SPEECH_PCM_BYTES);
    expect(spoken.durationMs).toBe(250);
  });

  test("`pcmBytes` sets the duration, rounded to a whole PCM16 sample", async () => {
    const speech = stubSpeech({ pcmBytes: 48_001 });
    onTestFinished(speech.restore);
    publishStepEnv({ ASSEMBLYAI_API_KEY: "key" });

    const spoken = await stepSpeak("hello");

    expect(spoken.pcm.length).toBe(48_000);
    expect(spoken.durationMs).toBe(1000);
  });

  test("`error` is a provider that ANSWERED and refused, not an absent one", async () => {
    const speech = stubSpeech({ error: new Error("voice not found") });
    onTestFinished(speech.restore);
    publishStepEnv({ ASSEMBLYAI_API_KEY: "key" });

    await expect(stepSpeak("hello")).rejects.toThrow("voice not found");
    expect(speech.calls).toHaveLength(1);
  });

  test("restore unpublishes, so the next file's steps do not speak into this log", async () => {
    const speech = stubSpeech();
    publishStepEnv({ ASSEMBLYAI_API_KEY: "key" });
    speech.restore();

    await expect(stepSpeak("hello")).rejects.toThrow("No speech synthesizer");
  });

  test("needs no credential: an env without one records an empty key", async () => {
    const speech = stubSpeech();
    onTestFinished(speech.restore);
    publishStepEnv({});

    await stepSpeak("hello");

    expect(speech.calls[0]?.apiKey).toBe("");
  });

  test("`requireApiKey` restores the real refusal, naming the variable", async () => {
    const speech = stubSpeech({ requireApiKey: true });
    onTestFinished(speech.restore);
    publishStepEnv({});

    await expect(stepSpeak("hello")).rejects.toThrow("ASSEMBLYAI_API_KEY");
    expect(speech.calls).toEqual([]);
  });
});
