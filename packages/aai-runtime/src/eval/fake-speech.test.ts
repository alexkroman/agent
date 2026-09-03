// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { requiredProviderEnvVars } from "../providers/resolve.ts";
import {
  createFakeSttOpener,
  createFakeTtsOpener,
  FAKE_SPEECH_API_KEY_ENV,
  installFakeSpeech,
} from "./fake-speech.ts";

const OPEN = { sampleRate: 16_000, apiKey: "k", signal: AbortSignal.abort() };

describe("the fake STT stage", () => {
  test("emits a partial and a committed turn to every subscriber", async () => {
    const opener = createFakeSttOpener("spec-stt");
    const session = await opener.open(OPEN);
    const partials: string[] = [];
    const finals: string[] = [];
    session.on("partial", (text) => partials.push(text));
    const off = session.on("final", (text) => finals.push(text));
    opener.last()?.partial("where is order");
    opener.last()?.commit("where is order W1234");
    off();
    opener.last()?.commit("ignored after unsubscribe");
    expect(partials).toEqual(["where is order"]);
    expect(finals).toEqual(["where is order W1234"]);
  });

  test("swallows client audio and closes without error", async () => {
    const session = await createFakeSttOpener("spec-stt").open(OPEN);
    session.sendAudio(new Int16Array(160));
    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("the fake TTS stage", () => {
  test("records what reached TTS and ends the turn on flush", async () => {
    const opener = createFakeTtsOpener("spec-tts");
    const session = await opener.open({ sampleRate: 24_000, apiKey: "k", signal: OPEN.signal });
    let dones = 0;
    session.on("done", () => {
      dones += 1;
    });
    session.sendText("It shipped ");
    session.sendText("yesterday.");
    session.flush();
    expect(opener.last()?.spoken).toEqual(["It shipped ", "yesterday."]);
    expect(dones).toBe(1);
  });

  test("forwards NO audio, which is what stops the harness barging in", async () => {
    const session = await createFakeTtsOpener("spec-tts").open({
      sampleRate: 24_000,
      apiKey: "k",
      signal: OPEN.signal,
    });
    const audio: unknown[] = [];
    session.on("audio", (pcm) => audio.push(pcm));
    session.flush();
    session.cancel();
    expect(audio).toEqual([]);
    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("installFakeSpeech", () => {
  test("registers both stages, so a runtime resolves them like any provider", () => {
    const fake = installFakeSpeech();
    try {
      const needed = requiredProviderEnvVars({ stt: fake.stt, tts: fake.tts });
      expect(needed).toContain(FAKE_SPEECH_API_KEY_ENV);
      expect(fake.env[FAKE_SPEECH_API_KEY_ENV]).toBeTypeOf("string");
    } finally {
      fake.release();
    }
  });

  test("each install gets its OWN kinds, so two sessions cannot cross-talk", () => {
    const a = installFakeSpeech();
    const b = installFakeSpeech();
    try {
      expect(a.stt.kind).not.toBe(b.stt.kind);
      expect(a.tts.kind).not.toBe(b.tts.kind);
    } finally {
      a.release();
      b.release();
    }
  });

  test("release unregisters the kinds it added", () => {
    const fake = installFakeSpeech();
    fake.release();
    // An unregistered kind resolves no credential of its own; the registry
    // lookup that would open it is gone with it.
    expect(requiredProviderEnvVars({ stt: fake.stt, tts: fake.tts })).not.toContain(
      FAKE_SPEECH_API_KEY_ENV,
    );
  });

  test("no session exists until the runtime opens one", () => {
    const fake = installFakeSpeech();
    try {
      expect(fake.sttSession()).toBeUndefined();
      expect(fake.ttsSession()).toBeUndefined();
    } finally {
      fake.release();
    }
  });
});
