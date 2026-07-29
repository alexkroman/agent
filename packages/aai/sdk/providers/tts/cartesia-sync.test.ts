// Copyright 2026 the AAI authors. MIT license.
// One-shot Cartesia synthesis: request shape, auth header, error mapping.

import { describe, expect, test, vi } from "vitest";
import { CARTESIA_API_VERSION, CARTESIA_TTS_BYTES_URL, syncSynthesize } from "./cartesia-sync.ts";

function okFetch(body: Uint8Array): typeof globalThis.fetch {
  return vi.fn(async () => new Response(body.slice().buffer as ArrayBuffer, { status: 200 }));
}

describe("syncSynthesize", () => {
  test("POSTs the bytes request and returns raw PCM", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const fetchFn = okFetch(pcm);
    const out = await syncSynthesize({
      text: "Hello!",
      voice: "voice-1",
      sampleRate: 24_000,
      apiKey: "ck",
      fetch: fetchFn,
    });
    expect([...out]).toEqual([...pcm]);

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(CARTESIA_TTS_BYTES_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ck");
    expect(headers["Cartesia-Version"]).toBe(CARTESIA_API_VERSION);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model_id: "sonic-2",
      transcript: "Hello!",
      voice: { mode: "id", id: "voice-1" },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24_000 },
      language: "en",
    });
  });

  test("honors model and language overrides", async () => {
    const fetchFn = okFetch(new Uint8Array(0));
    await syncSynthesize({
      text: "Hallo",
      voice: "v",
      model: "sonic-3",
      language: "de",
      sampleRate: 16_000,
      apiKey: "ck",
      fetch: fetchFn,
    });
    const body = JSON.parse(
      ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.model_id).toBe("sonic-3");
    expect(body.language).toBe("de");
  });

  test("non-2xx throws with the API detail, never the key", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ message: "voice not found" }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const err = await syncSynthesize({
      text: "x",
      voice: "missing",
      sampleRate: 24_000,
      apiKey: "secret-key",
      fetch: fetchFn,
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("HTTP 404");
    expect((err as Error).message).toContain("voice not found");
    expect((err as Error).message).not.toContain("secret-key");
  });
});
