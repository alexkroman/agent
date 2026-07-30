// Copyright 2026 the AAI authors. MIT license.
// Sync API client specs: request shape (endpoint, raw-key auth, model
// header, multipart parts), PCM validation, and error surfacing.

import { describe, expect, test } from "vitest";
import { fetchMock, fetchMockJson } from "../../_test-utils.ts";
import {
  SYNC_TRANSCRIBE_EU_URL,
  SYNC_TRANSCRIBE_MODEL,
  SYNC_TRANSCRIBE_URL,
  syncTranscribe,
} from "./assemblyai-sync.ts";

const okFetch = () => fetchMockJson({ text: "hello world", words: [] });

type SentParts = {
  boundary: string;
  /** Raw bytes of the `audio` part. */
  audio: Uint8Array;
  audioHeaders: string;
  /** The `config` part's text, absent when the part wasn't sent. */
  config: string | undefined;
};

/**
 * Decode a request `init` back into its multipart parts. Deliberately parses
 * the bytes rather than reading a `FormData` — the encoding is hand-rolled
 * (see the module doc), so the bytes are the contract.
 */
function sentParts(init: RequestInit | undefined): SentParts {
  const headers = init?.headers as Record<string, string> | undefined;
  const boundary = /boundary=([^\s;]+)/.exec(headers?.["Content-Type"] ?? "")?.[1];
  if (!boundary) throw new Error(`no multipart boundary: ${headers?.["Content-Type"]}`);
  const bytes = init?.body as Uint8Array;
  if (!(bytes instanceof Uint8Array)) throw new Error(`body is not bytes: ${typeof bytes}`);

  // latin1 keeps byte↔char 1:1, so offsets found in the text map onto `bytes`.
  const text = Buffer.from(bytes).toString("latin1");
  const audioStart = text.indexOf("\r\n\r\n") + 4;
  const audioEnd = text.indexOf(`\r\n--${boundary}`, audioStart);

  return {
    boundary,
    audio: bytes.slice(audioStart, audioEnd),
    audioHeaders: text.slice(0, audioStart),
    config: /name="config"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1],
  };
}

describe("syncTranscribe", () => {
  test("posts multipart WAV to the sync endpoint with raw-key auth and model header", async () => {
    const fetchFn = okFetch();
    const result = await syncTranscribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      apiKey: "test-key",
      fetch: fetchFn,
    });
    expect(result.text).toBe("hello world");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(SYNC_TRANSCRIBE_URL);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("test-key");
    expect(headers["X-AAI-Model"]).toBe(SYNC_TRANSCRIBE_MODEL);
    // A byte-array body infers no boundary — the header has to carry it.
    expect(headers["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=----aai-[0-9a-f]{32}$/,
    );
    const parts = sentParts(init);
    expect(parts.audioHeaders).toContain('name="audio"; filename="audio.wav"');
    expect(parts.audioHeaders).toContain("Content-Type: audio/wav");
    expect(parts.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(parts.config).toBeUndefined();
  });

  test("raw PCM carries sample_rate and channels in the config part", async () => {
    const fetchFn = okFetch();
    await syncTranscribe({
      audio: new Uint8Array(8),
      contentType: "audio/pcm",
      sampleRate: 16_000,
      channels: 1,
      apiKey: "k",
      fetch: fetchFn,
    });
    const parts = sentParts(fetchFn.mock.calls[0]?.[1]);
    expect(parts.audioHeaders).toContain('filename="audio.pcm"');
    expect(parts.audioHeaders).toContain("Content-Type: audio/pcm");
    expect(parts.audio.length).toBe(8);
    expect(JSON.parse(parts.config ?? "")).toEqual({ sample_rate: 16_000, channels: 1 });
  });

  test("a Blob or ArrayBuffer input is read to bytes, never sent as the body", async () => {
    for (const audio of [new Blob([new Uint8Array([9, 8, 7])]), new Uint8Array([9, 8, 7]).buffer]) {
      const fetchFn = okFetch();
      await syncTranscribe({ audio, apiKey: "k", fetch: fetchFn });
      const parts = sentParts(fetchFn.mock.calls[0]?.[1]);
      expect(parts.audio).toEqual(new Uint8Array([9, 8, 7]));
    }
  });

  test("an offset view sends only its own bytes", async () => {
    const fetchFn = okFetch();
    const backing = new Uint8Array([0, 0, 5, 6, 0]);
    await syncTranscribe({ audio: backing.subarray(2, 4), apiKey: "k", fetch: fetchFn });
    expect(sentParts(fetchFn.mock.calls[0]?.[1]).audio).toEqual(new Uint8Array([5, 6]));
  });

  test("audio/pcm without sampleRate/channels is rejected before any request", async () => {
    const fetchFn = okFetch();
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
    const fetchFn = okFetch();
    await syncTranscribe({ audio: new Uint8Array(2), apiKey: "k", region: "eu", fetch: fetchFn });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(SYNC_TRANSCRIBE_EU_URL);
  });

  test("optional config fields pass through with the API's field names", async () => {
    const fetchFn = okFetch();
    await syncTranscribe({
      audio: new Uint8Array(2),
      apiKey: "k",
      prompt: "medical terms",
      keyterms: ["ibuprofen"],
      languageCode: "de",
      timestamps: true,
      fetch: fetchFn,
    });
    expect(JSON.parse(sentParts(fetchFn.mock.calls[0]?.[1]).config ?? "")).toEqual({
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
