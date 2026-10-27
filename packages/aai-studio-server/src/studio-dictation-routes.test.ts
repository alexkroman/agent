// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /studio/dictation` through the whole studio app: it is authenticated,
 * the clip and the CALLER's key reach the dictation call, a refusal comes back
 * readable, and an oversized or empty body is refused before any call.
 */

import { DICTATION_MAX_BYTES, type transcribeDictation } from "@alexkroman1/aai/experimental";
import { TranscribeError } from "@alexkroman1/aai/step";
import { createRateLimiter } from "aai-server/http";
import { authHeaders } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";

type Transcribe = typeof transcribeDictation;

async function mount(transcribe: Transcribe, limit?: number) {
  const { fetch } = await createTestCombined({
    transcribe,
    ...(limit === undefined
      ? {}
      : { studioRateLimiters: { dictation: createRateLimiter({ limit, windowMs: 60_000 }) } }),
  });
  const post = (body: Uint8Array, headers: Record<string, string> = authHeaders("key1")) =>
    fetch("/studio/dictation", {
      method: "POST",
      headers: { ...headers, "Content-Type": "audio/wav" },
      body,
    });
  return { post };
}

const CLIP = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);

describe("POST /studio/dictation", () => {
  test("transcribes the clip on the caller's own key", async () => {
    const transcribe = vi.fn<Transcribe>(async () => ({ text: "add a weather tool" }));
    const { post } = await mount(transcribe);

    const res = await post(CLIP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "add a weather tool" });
    const [audio, opts] = transcribe.mock.calls[0] ?? [];
    expect(Array.from(audio as Uint8Array)).toEqual(Array.from(CLIP));
    expect(opts?.apiKey).toBe("key1");
    expect(opts?.type).toBe("audio/wav");
  });

  test("requires a signed-in caller", async () => {
    const transcribe = vi.fn<Transcribe>();
    const { post } = await mount(transcribe);
    const res = await post(CLIP, {});
    expect(res.status).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("an empty body and an oversized one are refused before any call", async () => {
    const transcribe = vi.fn<Transcribe>();
    const { post } = await mount(transcribe);

    const empty = await post(new Uint8Array());
    expect(empty.status).toBe(400);

    const huge = await post(new Uint8Array(DICTATION_MAX_BYTES + 1));
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { error: string }).error).toContain("Recording too long");
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("a refusal from the service reads as one, and a rate limit keeps its status", async () => {
    const refused = await mount(async () => {
      throw new TranscribeError("audio.wav failed: HTTP 401 — Invalid API key", {
        status: 401,
        retryable: false,
      });
    });
    const res = await refused.post(CLIP);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("Invalid API key");

    const limited = await mount(async () => {
      throw new TranscribeError("slow down", {
        status: 429,
        retryable: true,
        retryAfter: new Date(Date.now() + 5000),
      });
    });
    const busy = await limited.post(CLIP);
    expect(busy.status).toBe(429);
    expect(Number(busy.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("is metered per caller", async () => {
    const transcribe = vi.fn<Transcribe>(async () => ({ text: "hi" }));
    const { post } = await mount(transcribe, 1);
    expect((await post(CLIP)).status).toBe(200);
    expect((await post(CLIP)).status).toBe(429);
    expect(transcribe).toHaveBeenCalledOnce();
  });
});
