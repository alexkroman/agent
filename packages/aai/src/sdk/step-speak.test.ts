// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { publishStepEnv } from "./step-env.ts";
import {
  publishSpeechSynthesizer,
  SPEECH_UNAVAILABLE_MESSAGE,
  type SpeechSynthesizer,
  STEP_SPEAK_SAMPLE_RATE,
  stepSpeak,
} from "./step-speak.ts";
import { WAV_HEADER_BYTES } from "./wav.ts";

/** One second of 24 kHz mono PCM16, which is what the default rate makes it. */
const ONE_SECOND = new Uint8Array(48_000);

afterEach(() => {
  publishSpeechSynthesizer(undefined);
  publishStepEnv(undefined);
});

/** Publish a recording synthesizer and hand back what it was asked. */
function install(pcm: Uint8Array = ONE_SECOND): {
  calls: Parameters<SpeechSynthesizer>[0][];
} {
  const calls: Parameters<SpeechSynthesizer>[0][] = [];
  publishSpeechSynthesizer((request) => {
    calls.push(request);
    return Promise.resolve(pcm);
  });
  publishStepEnv({ ASSEMBLYAI_API_KEY: "key-from-env" });
  return { calls };
}

describe("stepSpeak", () => {
  test("frames the synthesizer's PCM as a WAV and measures it", async () => {
    install();

    const spoken = await stepSpeak("Three findings, and one of them is new.");

    expect(spoken.audio.length).toBe(WAV_HEADER_BYTES + ONE_SECOND.length);
    expect(spoken.pcm).toBe(ONE_SECOND);
    expect(spoken.sampleRate).toBe(STEP_SPEAK_SAMPLE_RATE);
    expect(spoken.durationMs).toBe(1000);
    expect(spoken.voice).toBe("jane");
  });

  test("resolves the credential from the step env rather than taking one", async () => {
    const { calls } = install();

    await stepSpeak("hello");

    expect(calls[0]?.apiKey).toBe("key-from-env");
  });

  test("reads an alternate credential when `apiKeyEnv` names one", async () => {
    const { calls } = install();
    publishStepEnv({ ASSEMBLYAI_API_KEY: "production", STAGING_KEY: "staging" });

    await stepSpeak("hello", { apiKeyEnv: "STAGING_KEY" });

    expect(calls[0]?.apiKey).toBe("staging");
  });

  test("passes the voice, language and rate through, trimming the text", async () => {
    const { calls } = install();

    await stepSpeak("  buenos dias  ", { voice: "lola", language: "es", sampleRate: 16_000 });

    expect(calls[0]).toMatchObject({
      text: "buenos dias",
      voice: "lola",
      language: "es",
      sampleRate: 16_000,
    });
  });

  test("omits the language when the caller named none, so the service infers it", async () => {
    const { calls } = install();

    await stepSpeak("hello");

    expect(calls[0]?.language).toBeUndefined();
  });

  test("refuses blank text rather than storing an empty file", async () => {
    const { calls } = install();

    await expect(stepSpeak("   ")).rejects.toThrow("nothing to say");
    expect(calls).toHaveLength(0);
  });

  test("names both causes when nothing published a synthesizer", async () => {
    publishStepEnv({ ASSEMBLYAI_API_KEY: "key" });

    await expect(stepSpeak("hello")).rejects.toThrow(SPEECH_UNAVAILABLE_MESSAGE);
  });

  test("reports a missing credential by name before dialling anything", async () => {
    const calls = vi.fn();
    publishSpeechSynthesizer(calls);
    publishStepEnv({});

    await expect(stepSpeak("hello")).rejects.toThrow("ASSEMBLYAI_API_KEY");
    expect(calls).not.toHaveBeenCalled();
  });

  test("a caller's signal reaches the synthesizer alongside the deadline", async () => {
    const { calls } = install();
    const controller = new AbortController();

    await stepSpeak("hello", { signal: controller.signal });
    const passed = calls[0]?.signal;
    expect(passed?.aborted).toBe(false);
    controller.abort(new Error("caller changed their mind"));

    expect(passed?.aborted).toBe(true);
  });
});
