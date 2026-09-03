// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { TranscribeError } from "./_transcribe-shared.ts";
import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
} from "./step-transcribe.ts";
import { stepTranscribeSync } from "./step-transcribe-sync.ts";
import { publishUploadReader } from "./step-uploads.ts";
import { stubStepFetch, stubTranscribe, stubUploads } from "./testing.ts";

/**
 * Driven through the real steps, never against the fake directly.
 *
 * The value of this fake is that a spec stops restating the wire, so a test
 * that asserted on the JSON it answers would be testing the restatement. What
 * is asserted here is what `stepTranscribe*` — the code a template calls — sees.
 */
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  publishUploadReader(undefined);
});

function fake(...args: Parameters<typeof stubTranscribe>) {
  const provider = stubTranscribe(...args);
  restores.push(provider.restore);
  return provider;
}

function recording(bytes = new Uint8Array(2048)) {
  const uploads = stubUploads({ rec: bytes });
  restores.push(uploads.restore);
  return uploads;
}

describe("the async trio", () => {
  test("upload, submit and poll each get an answer the SDK can read", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    recording();
    fake({ text: "we ship tuesday", durationSec: 42 });

    const { audioUrl } = await stepTranscribeUpload("rec");
    const { id } = await stepTranscribeSubmit(audioUrl);
    const progress = await stepTranscribePoll(id);

    expect(audioUrl).toBe("https://cdn.assemblyai.test/upload/stub");
    // Minted rather than random, for the reason `stubUploads`'s ids are: a spec
    // asserting a run journaled the job it later polled needs a value to write
    // down.
    expect(id).toBe("stub_transcript_1");
    expect(progress).toEqual({
      done: true,
      status: "completed",
      transcript: { id: "stub_transcript_1", text: "we ship tuesday", durationMs: 42_000 },
    });
  });

  test("records every call with the leg it belonged to, and the file it streamed", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    recording(new Uint8Array(5000));
    const provider = fake();

    await stepTranscribeSubmit((await stepTranscribeUpload("rec")).audioUrl);

    expect(provider.calls.map((call) => call.leg)).toEqual(["upload", "submit"]);
    // The body is DRAINED, so the assertion is about the bytes that went out
    // rather than about an iterator the request had already eaten.
    const sent = provider.calls[0]?.body;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(sent instanceof Uint8Array ? sent.length : -1).toBe(5000);
    // And the raw key, unprefixed — a `Bearer ` here is a 401 that reads like a
    // wrong key, which is the SDK's contract and worth seeing through the fake.
    expect(provider.calls[0]?.headers.Authorization).toBe("sk-test");
  });

  test("pendingPolls makes a job take more than one poll, counted per job", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ pendingPolls: 2, text: "done at last" });

    expect(await stepTranscribePoll("job_a")).toEqual({ done: false, status: "processing" });
    expect(await stepTranscribePoll("job_a")).toEqual({ done: false, status: "processing" });
    // A second job has its own countdown rather than sharing this one's.
    expect(await stepTranscribePoll("job_b")).toMatchObject({ done: false });
    expect(await stepTranscribePoll("job_a")).toMatchObject({ done: true });
  });

  test("a job the provider gave up on is TERMINAL, not 'not done yet'", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ jobError: "audio too quiet" });

    // The branch a flow is most likely to get wrong: the request SUCCEEDED and
    // the answer is no, so a retry polls a dead job until the budget runs out.
    const error = await stepTranscribePoll("job_a").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TranscribeError);
    expect((error as TranscribeError).retryable).toBe(false);
    expect((error as TranscribeError).message).toContain("audio too quiet");
  });

  test("an empty transcript is refused by the poll, which is the SDK's own rule", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ text: "" });

    // A recording of silence succeeds and answers with nothing, which is the
    // failure that reads least like one — so the fake has to be able to stage it.
    await expect(stepTranscribePoll("job_a")).rejects.toThrow(/no speech in that recording/);
  });
});

describe("the sync endpoint", () => {
  test("answers each request from the text list, the last repeating", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ text: ["first segment", "second segment"] });

    const said: string[] = [];
    for (let n = 0; n < 3; n += 1) said.push((await stepTranscribeSync(new Uint8Array(4))).text);

    // A fan-out wants a different line per segment; one that ran out mid-fan-out
    // would fail on the stub rather than on the code.
    expect(said).toEqual(["first segment", "second segment", "second segment"]);
  });

  test("an empty answer is accepted here, unlike the async poll", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ text: "" });

    // A silent segment in a fan-out is ordinary, and a throw would fail a whole
    // recording over a pause in it.
    await expect(stepTranscribeSync(new Uint8Array(4))).resolves.toEqual({ text: "" });
  });
});

describe("refusals", () => {
  test("a 429 becomes a real TranscribeError, classified by the SDK", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ failure: { leg: "sync", status: 429, message: "slow down", retryAfterSeconds: 30 } });

    const error = await stepTranscribeSync(new Uint8Array(4)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TranscribeError);
    // The verdict is `transcribeFailure`'s, not the fake's — which is the whole
    // reason a refusal is staged as a STATUS. A fake that minted the error would
    // be asserting the classification a spec is trying to test.
    expect((error as TranscribeError).retryable).toBe(true);
    expect((error as TranscribeError).retryAfter).toBeInstanceOf(Date);
    expect((error as TranscribeError).message).toContain("slow down");
  });

  test("a 400 is terminal, and the same staging says so", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    fake({ failure: { status: 400, message: "bad field" } });

    const error = await stepTranscribeSubmit("https://cdn/x").catch((thrown: unknown) => thrown);
    expect((error as TranscribeError).retryable).toBe(false);
  });

  test("a refusal naming a leg leaves the others answering", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    recording();
    fake({ failure: { leg: "submit", status: 400 } });

    await expect(stepTranscribeUpload("rec")).resolves.toMatchObject({
      audioUrl: expect.any(String),
    });
    await expect(stepTranscribeSubmit("https://cdn/x")).rejects.toBeInstanceOf(TranscribeError);
  });

  test("with no leg named, every call refuses", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    recording();
    fake({ failure: { status: 503 } });

    await expect(stepTranscribeUpload("rec")).rejects.toBeInstanceOf(TranscribeError);
    await expect(stepTranscribeSubmit("https://cdn/x")).rejects.toBeInstanceOf(TranscribeError);
    await expect(stepTranscribePoll("job_a")).rejects.toBeInstanceOf(TranscribeError);
  });
});

describe("everything else", () => {
  test("a non-transcription call reaches `otherwise`", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    // Publishing a stepFetch REPLACES, so a flow that transcribes AND calls a
    // model cannot install two fakes — this is the seam for the second one.
    const provider = fake({
      otherwise: (request) =>
        request.url.includes("llm-gateway")
          ? { body: { choices: [{ message: { content: "summary" } }] } }
          : undefined,
    });

    const { stepFetch } = await import("./step-fetch.ts");
    const answered = await stepFetch("https://llm-gateway.test/v1/chat/completions");
    expect(await answered.json()).toMatchObject({ choices: expect.any(Array) });

    // And an unrouted URL is a 404 naming itself, rather than an empty 200 a
    // step would try to parse.
    const missed = await stepFetch("https://elsewhere.test/thing");
    expect(missed.status).toBe(404);
    expect(provider.calls.map((call) => call.leg)).toEqual(["other", "other"]);
  });

  test("restore unpublishes, so the next file's steps do not answer to this one", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const provider = stubTranscribe({ text: "from the first file" });
    provider.restore();

    // Proven by publishing a sentinel in its place: a fake left published would
    // answer this instead, which is the cross-file leak that presents as a
    // passing test somewhere else. (Asserting a real request fails would prove
    // the same thing by making one, which a unit test may not do.)
    const sentinel = stubStepFetch(() => ({ body: { status: "completed", text: "sentinel" } }));
    restores.push(sentinel.restore);

    expect(await stepTranscribePoll("job_a")).toMatchObject({
      transcript: { text: "sentinel" },
    });
    expect(provider.calls).toEqual([]);
  });
});
