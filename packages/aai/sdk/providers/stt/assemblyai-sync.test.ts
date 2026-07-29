// Copyright 2026 the AAI authors. MIT license.
// Sync API client specs: request shape (endpoint, raw-key auth, model
// header, multipart parts), PCM validation, and error surfacing.

import { describe, expect, test, vi } from "vitest";
import {
  SYNC_TRANSCRIBE_EU_URL,
  SYNC_TRANSCRIBE_MODEL,
  SYNC_TRANSCRIBE_URL,
  syncTranscribe,
} from "./assemblyai-sync.ts";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function fetchMock(response: () => Response) {
  const fn = vi.fn(async (..._args: FetchArgs) => response());
  return fn as unknown as typeof globalThis.fetch & { mock: { calls: FetchArgs[] } };
}

const okJson = () =>
  new Response(JSON.stringify({ text: "hello world", words: [] }), { status: 200 });

describe("syncTranscribe", () => {
  test("posts multipart WAV to the sync endpoint with raw-key auth and model header", async () => {
    const fetchFn = fetchMock(okJson);
    const result = await syncTranscribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      apiKey: "test-key",
      fetch: fetchFn,
    });
    expect(result.text).toBe("hello world");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(SYNC_TRANSCRIBE_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "test-key",
      "X-AAI-Model": SYNC_TRANSCRIBE_MODEL,
    });
    const form = init?.body as FormData;
    const audio = form.get("audio") as Blob;
    expect(audio.type).toBe("audio/wav");
    expect(audio.size).toBe(4);
    expect(form.get("config")).toBeNull();
  });

  test("raw PCM carries sample_rate and channels in the config part", async () => {
    const fetchFn = fetchMock(okJson);
    await syncTranscribe({
      audio: new Uint8Array(8),
      contentType: "audio/pcm",
      sampleRate: 16_000,
      channels: 1,
      apiKey: "k",
      fetch: fetchFn,
    });
    const [, init] = fetchFn.mock.calls[0] ?? [];
    const form = init?.body as FormData;
    expect((form.get("audio") as Blob).type).toBe("audio/pcm");
    expect(JSON.parse(form.get("config") as string)).toEqual({
      sample_rate: 16_000,
      channels: 1,
    });
  });

  test("audio/pcm without sampleRate/channels is rejected before any request", async () => {
    const fetchFn = fetchMock(okJson);
    await expect(
      syncTranscribe({
        audio: new Uint8Array(8),
        contentType: "audio/pcm",
        apiKey: "k",
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/sampleRate and channels/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("region 'eu' selects the EU endpoint", async () => {
    const fetchFn = fetchMock(okJson);
    await syncTranscribe({ audio: new Uint8Array(2), apiKey: "k", region: "eu", fetch: fetchFn });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(SYNC_TRANSCRIBE_EU_URL);
  });

  test("optional config fields pass through with the API's field names", async () => {
    const fetchFn = fetchMock(okJson);
    await syncTranscribe({
      audio: new Uint8Array(2),
      apiKey: "k",
      prompt: "medical terms",
      keyterms: ["ibuprofen"],
      languageCode: "de",
      timestamps: true,
      fetch: fetchFn,
    });
    const form = fetchFn.mock.calls[0]?.[1]?.body as FormData;
    expect(JSON.parse(form.get("config") as string)).toEqual({
      prompt: "medical terms",
      keyterms_prompt: ["ibuprofen"],
      language_code: "de",
      timestamps: true,
    });
  });

  test("non-2xx surfaces the API's error message, never the key", async () => {
    const fetchFn = fetchMock(
      () => new Response(JSON.stringify({ message: "audio too long" }), { status: 413 }),
    );
    const err = await syncTranscribe({
      audio: new Uint8Array(2),
      apiKey: "sk-secret",
      fetch: fetchFn,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/HTTP 413.*audio too long/);
    expect(err?.message).not.toContain("sk-secret");
  });
});
