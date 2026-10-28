// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the dictation call a server makes on a browser's behalf: the key
 * is a VALUE and travels raw, the transport is the one injected, an empty
 * answer is an answer, and a refusal carries its verdict.
 */

import { describe, expect, test, vi } from "vitest";
import { TranscribeError } from "./_transcribe-shared.ts";
import {
  DICTATION_ENDPOINT,
  DICTATION_MAX_BYTES,
  DICTATION_MAX_SECONDS,
  DICTATION_MODEL,
  DICTATION_SAMPLE_RATE,
  type DictationFetch,
  transcribeDictation,
} from "./dictation.ts";
import { encodeWav, WAV_HEADER_BYTES } from "./wav.ts";

function replying(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<DictationFetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
  );
}

describe("transcribeDictation", () => {
  test("posts the clip with the raw key and the model header, and trims the text", async () => {
    const send = replying(200, { text: "  Add a weather tool.  " });

    const result = await transcribeDictation(new Uint8Array([1, 2, 3]), {
      apiKey: "sk-user",
      fetch: send,
    });

    expect(result).toEqual({ text: "Add a weather tool." });
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe(DICTATION_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers.Authorization).toBe("sk-user");
    expect(init?.headers["X-AAI-Model"]).toBe(DICTATION_MODEL);
    expect(init?.headers["Content-Type"]).toContain("multipart/form-data");
    const body = new TextDecoder().decode(init?.body);
    expect(body).toContain('name="audio"; filename="audio.wav"');
  });

  test("an empty transcript is an answer, not a failure", async () => {
    const send = replying(200, { text: "" });
    expect(await transcribeDictation(new Uint8Array([1]), { apiKey: "k", fetch: send })).toEqual({
      text: "",
    });
  });

  test("a refusal carries the status and the endpoint's own detail", async () => {
    const send = replying(401, { detail: "Invalid API key" });
    const err = await transcribeDictation(new Uint8Array([1]), {
      apiKey: "k",
      fetch: send,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect((err as TranscribeError).status).toBe(401);
    expect((err as TranscribeError).retryable).toBe(false);
    expect((err as TranscribeError).message).toContain("Invalid API key");
  });

  test("a rate limit is retryable and names its wait", async () => {
    const send = replying(429, { detail: "slow down" }, { "Retry-After": "3" });
    const err = (await transcribeDictation(new Uint8Array([1]), {
      apiKey: "k",
      fetch: send,
    }).catch((e: unknown) => e)) as TranscribeError;
    expect(err.retryable).toBe(true);
    expect(err.retryAfter).toBeInstanceOf(Date);
  });

  test("an empty key is refused before any request", async () => {
    const send = replying(200, { text: "never" });
    await expect(
      transcribeDictation(new Uint8Array([1]), { apiKey: "", fetch: send }),
    ).rejects.toThrow(/API key/);
    expect(send).not.toHaveBeenCalled();
  });

  test("the byte ceiling is exactly a full-length mono 16-bit clip", () => {
    const samples = new Uint8Array(DICTATION_SAMPLE_RATE * DICTATION_MAX_SECONDS * 2);
    const wav = encodeWav(samples, { sampleRate: DICTATION_SAMPLE_RATE });
    expect(wav.byteLength).toBe(DICTATION_MAX_BYTES);
    expect(DICTATION_MAX_BYTES - samples.byteLength).toBe(WAV_HEADER_BYTES);
  });
});
