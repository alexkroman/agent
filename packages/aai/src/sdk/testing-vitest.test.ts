// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { stepFetch } from "./step-fetch.ts";
import { stepReport } from "./step-report.ts";
import { stepSpeak } from "./step-speak.ts";
import { stepTranscribePoll } from "./step-transcribe.ts";
import { stepUploadInfo } from "./step-uploads.ts";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
} from "./testing-vitest.ts";

/**
 * Each fake is asserted twice: once that it is INSTALLED, and once — from the
 * next test — that it is GONE.
 *
 * The second half is the whole reason this module exists. `onTestFinished` runs
 * against the test that registered it, so a fake installed inside a test body
 * (which is where every template's `stubProvider()` helper is called) unwinds
 * without the caller keeping a registry. A leak here does not fail this file;
 * it fails a different one, later, which is what makes it worth pinning.
 */
describe("installStubUploads", () => {
  test("publishes the store", async () => {
    const uploads = installStubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
    await expect(stepUploadInfo("upl_1")).resolves.toMatchObject({ size: 3 });
    expect(uploads.writes).toEqual([]);
  });

  test("and the store is gone by the next test", async () => {
    await expect(stepUploadInfo("upl_1")).rejects.toThrow();
  });
});

describe("installStubStepFetch", () => {
  test("publishes the fetch, recording what the step sent", async () => {
    const fetched = installStubStepFetch(() => ({ body: { ok: true } }));
    const answered = await stepFetch("https://example.test/thing");
    expect(await answered.json()).toEqual({ ok: true });
    expect(fetched.calls.map((call) => call.url)).toEqual(["https://example.test/thing"]);
  });

  test("defaults to an empty 200 when given no answer", async () => {
    installStubStepFetch();
    const answered = await stepFetch("https://example.test/thing");
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({});
  });
});

describe("installStubReporter", () => {
  test("captures what a step narrates", async () => {
    const reported = installStubReporter();
    await stepReport("halfway");
    expect(reported.lines).toEqual(["halfway"]);
  });

  test("and is unpublished by the next test", async () => {
    // Back to the console fallback, which is what an unpublished slot means —
    // and the proof that `onTestFinished` really ran the previous test's
    // `restore`, with no `afterEach` anywhere in this file.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await stepReport("nobody is listening");
    expect(spy).toHaveBeenCalled();
  });
});

describe("installStubSpeech", () => {
  test("publishes a synthesizer and records what it was asked to say", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const speech = installStubSpeech();
    await stepSpeak("Three findings.");
    expect(speech.calls[0]?.text).toBe("Three findings.");
  });

  test("a per-test install needs no registry: this test's fake is the one that answers", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    // Failing rather than speaking is the half a spec cannot write by leaving
    // the slot empty: unpublished means "no synthesizer here", which is a
    // different sentence and a different branch from a provider that refused.
    installStubSpeech({ error: new Error("provider said no") });
    await expect(stepSpeak("Anything.")).rejects.toThrow("provider said no");
  });
});

describe("installStubTranscribe", () => {
  test("answers the transcription endpoints", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const provider = installStubTranscribe({ text: "we ship tuesday" });
    await expect(stepTranscribePoll("job_a")).resolves.toMatchObject({
      transcript: { text: "we ship tuesday" },
    });
    expect(provider.calls.map((call) => call.leg)).toEqual(["poll"]);
  });

  test("a per-test install needs no registry: this test's fake is the one that answers", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    // The registry this replaces — `const restores: (() => void)[]` plus an
    // `afterEach` that splices it — appeared three times in one template spec.
    installStubTranscribe({ text: "this test's own answer" });
    await expect(stepTranscribePoll("job_a")).resolves.toMatchObject({
      transcript: { text: "this test's own answer" },
    });
  });
});

describe("installStubGateway", () => {
  test("installs the fake as the global fetch and returns its live call log", async () => {
    const calls = installStubGateway('{"headline":"Otters use tools"}');
    await fetch("https://gateway.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Otters use tools." }] }),
    });
    expect(calls[0]?.prompt).toBe("Otters use tools.");
  });
});
