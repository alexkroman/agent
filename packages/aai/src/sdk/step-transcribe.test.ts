// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the async transcription API.
 *
 * Every one of these is a rule one of the two templates that owned this flow
 * had already got right by hand and the other could have got wrong: the raw
 * key, the PLURAL `speech_models`, the caller's extras never shadowing the two
 * arguments, the recording streaming rather than being held, and — the pair
 * that decides whether a run retries or gives up — a provider refusal being
 * NOT retryable where a 429 is.
 */

import { describe, expect, test, vi } from "vitest";
import { TranscribeError } from "./_transcribe-shared.ts";
import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
  TRANSCRIBE_MODELS,
  TRANSCRIBE_WINDOW_BYTES,
} from "./step-transcribe.ts";
import { stubUploads } from "./testing-uploads.ts";

/** One canned JSON reply, and the recorder of what was asked for. */
function stubApi(replies: readonly { status?: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let at = 0;
  const fetchFn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(at, replies.length - 1)];
    at += 1;
    return new Response(JSON.stringify(reply?.body ?? {}), {
      status: reply?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchFn);
  return {
    calls,
    /** The parsed JSON body of the nth request. */
    sent(n: number): Record<string, unknown> {
      return JSON.parse(String(calls[n]?.init.body)) as Record<string, unknown>;
    },
  };
}

describe("stepTranscribeUpload", () => {
  test("streams the stored upload and answers with the URL", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const uploads = stubUploads({ rec: new Uint8Array([1, 2, 3, 4]) });
    const api = stubApi([{ body: { upload_url: "https://cdn.example/abc" } }]);

    expect(await stepTranscribeUpload("rec")).toEqual({ audioUrl: "https://cdn.example/abc" });
    expect(api.calls[0]?.url).toBe("https://api.assemblyai.com/v2/upload");
    uploads.restore();
  });

  test("sends the key RAW — a Bearer prefix is a 401 that reads like a bad key", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const uploads = stubUploads({ rec: new Uint8Array([1]) });
    const api = stubApi([{ body: { upload_url: "https://cdn.example/abc" } }]);

    await stepTranscribeUpload("rec");
    const headers = api.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("sk-test");
    uploads.restore();
  });

  test("honours a custom apiKeyEnv", async () => {
    vi.stubEnv("OTHER_KEY", "sk-other");
    const uploads = stubUploads({ rec: new Uint8Array([1]) });
    const api = stubApi([{ body: { upload_url: "https://cdn.example/abc" } }]);

    await stepTranscribeUpload("rec", { apiKeyEnv: "OTHER_KEY" });
    const headers = api.calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("sk-other");
    uploads.restore();
  });

  test("the body is an async iterable, so the file is never held whole", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    // Two windows plus a byte, so the generator has to run more than once.
    const uploads = stubUploads({ rec: new Uint8Array(TRANSCRIBE_WINDOW_BYTES * 2 + 1) });
    const api = stubApi([{ body: { upload_url: "https://cdn.example/abc" } }]);

    await stepTranscribeUpload("rec");
    const body = api.calls[0]?.init.body as AsyncIterable<Uint8Array>;
    expect(typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBe(
      "function",
    );
    const windows: number[] = [];
    for await (const chunk of body) windows.push(chunk.length);
    expect(windows).toEqual([TRANSCRIBE_WINDOW_BYTES, TRANSCRIBE_WINDOW_BYTES, 1]);
    uploads.restore();
  });

  test("a 200 that names no URL is a refusal, and not retryable", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const uploads = stubUploads({ rec: new Uint8Array([1]) });
    stubApi([{ body: {} }]);

    await expect(stepTranscribeUpload("rec")).rejects.toMatchObject({
      name: "TranscribeError",
      retryable: false,
    });
    uploads.restore();
  });

  // The worst shape available: a PLAUSIBLE WRONG ANSWER. `size` is the
  // contiguous readable PREFIX of an upload, not its final length, so a run
  // started against a still-arriving recording used to upload whatever had
  // landed, get a URL for it, and transcribe a truncated file — no error
  // anywhere, and a transcript that reads as the whole call. Refusing costs a
  // failed run; not refusing costs a wrong transcript nobody can tell from a
  // right one.
  test("REFUSES an upload that is still arriving rather than transcribing its prefix", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const uploads = stubUploads({ rec: { bytes: new Uint8Array([1, 2, 3, 4]), complete: false } });
    const api = stubApi([{ body: { upload_url: "https://cdn.example/abc" } }]);

    await expect(stepTranscribeUpload("rec")).rejects.toThrow(/still arriving/);
    // Nothing went out: the refusal is BEFORE the expensive leg, so a run started
    // a moment too early does not pay for an upload it must not use.
    expect(api.calls).toHaveLength(0);
    uploads.restore();
  });

  test("that refusal is NOT retryable — no number of attempts finishes the upload", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const uploads = stubUploads({ rec: { bytes: new Uint8Array([1]), complete: false } });
    stubApi([{ body: { upload_url: "https://cdn.example/abc" } }]);

    // An upload that died stays incomplete forever, and the default backoff is
    // ~0 ms — so retrying spends the file-sized step's whole budget in
    // milliseconds and still cannot help. The fix is the run's ORDER, which is a
    // fatal verdict's job to say.
    await expect(stepTranscribeUpload("rec")).rejects.toMatchObject({ retryable: false });
    uploads.restore();
  });
});

describe("stepTranscribeSubmit", () => {
  test("asks for the PLURAL speech_models — the singular field 400s", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const api = stubApi([{ body: { id: "t-1" } }]);

    expect(await stepTranscribeSubmit("https://cdn.example/abc")).toEqual({ id: "t-1" });
    expect(api.sent(0)).toEqual({
      audio_url: "https://cdn.example/abc",
      speech_models: TRANSCRIBE_MODELS,
    });
    expect(api.sent(0)).not.toHaveProperty("speech_model");
  });

  test("merges params verbatim and does not interpret them", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const api = stubApi([{ body: { id: "t-1" } }]);

    await stepTranscribeSubmit("https://cdn.example/abc", {
      params: { speaker_labels: true, language_code: "es" },
    });
    expect(api.sent(0)).toMatchObject({ speaker_labels: true, language_code: "es" });
  });

  test("params cannot shadow the two arguments this function takes", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const api = stubApi([{ body: { id: "t-1" } }]);

    await stepTranscribeSubmit("https://cdn.example/real", {
      models: ["custom"],
      params: { audio_url: "https://cdn.example/decoy", speech_models: ["decoy"] },
    });
    expect(api.sent(0)).toMatchObject({
      audio_url: "https://cdn.example/real",
      speech_models: ["custom"],
    });
  });

  test("a 429 is retryable and carries the service's own delay", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "30", "Content-Type": "application/json" },
          }),
      ),
    );

    const err = await stepTranscribeSubmit("https://cdn.example/abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect(err).toMatchObject({ status: 429, retryable: true });
    expect((err as TranscribeError).retryAfter).toBeInstanceOf(Date);
    expect((err as TranscribeError).message).toContain("slow down");
  });

  test("a 400 is NOT retryable", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubApi([{ status: 400, body: { error: "bad model" } }]);

    await expect(stepTranscribeSubmit("https://cdn.example/abc")).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
  });
});

describe("stepTranscribePoll", () => {
  test("an unfinished job reports progress and no transcript", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubApi([{ body: { status: "processing" } }]);

    expect(await stepTranscribePoll("t-1")).toEqual({ done: false, status: "processing" });
  });

  test("a finished job answers with the transcript — one round trip, not two", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const api = stubApi([
      { body: { status: "completed", text: "  Otters use tools.  ", audio_duration: 12.4 } },
    ]);

    expect(await stepTranscribePoll("t-1")).toEqual({
      done: true,
      status: "completed",
      transcript: { id: "t-1", text: "Otters use tools.", durationMs: 12_400 },
    });
    expect(api.calls).toHaveLength(1);
  });

  test("a failed job is a refusal the DevKit must not retry", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubApi([{ body: { status: "error", error: "corrupt audio" } }]);

    const err = await stepTranscribePoll("t-1").catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false });
    expect((err as TranscribeError).message).toContain("corrupt audio");
  });

  test("a recording of silence completes with no words, and that is refused", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubApi([{ body: { status: "completed", text: "   ", audio_duration: 30 } }]);

    await expect(stepTranscribePoll("t-1")).rejects.toMatchObject({ retryable: false });
  });

  test("an unknown status reads as unfinished rather than as done", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubApi([{ body: {} }]);

    expect(await stepTranscribePoll("t-1")).toEqual({ done: false, status: "unknown" });
  });
});
