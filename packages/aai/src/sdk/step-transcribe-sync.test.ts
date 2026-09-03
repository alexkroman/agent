// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the one-request transcription endpoint.
 *
 * The three that matter are the ones the async API answers differently: the
 * model rides a HEADER rather than a body field, the audio goes as multipart
 * rather than as a raw body, and an EMPTY transcript is a legitimate answer
 * here — a fan-out over segments routinely has silent ones, and refusing them
 * would fail a whole recording over a pause in it.
 */

import { describe, expect, test, vi } from "vitest";
import {
  stepTranscribeSync,
  TRANSCRIBE_SYNC_ENDPOINT,
  TRANSCRIBE_SYNC_MODEL,
} from "./step-transcribe-sync.ts";
import { wavHeader } from "./wav.ts";

function stubSync(reply: { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return {
    calls,
    headers: (): Record<string, string> => calls[0]?.init.headers as Record<string, string>,
  };
}

describe("stepTranscribeSync", () => {
  test("posts the audio and returns the trimmed text", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const sync = stubSync({ body: { text: "  Otters use tools.  " } });

    expect(await stepTranscribeSync(new Uint8Array([1, 2, 3]))).toEqual({
      text: "Otters use tools.",
    });
    expect(sync.calls[0]?.url).toBe(TRANSCRIBE_SYNC_ENDPOINT);
  });

  test("the model is a HEADER on this endpoint, and the key is raw", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const sync = stubSync({ body: { text: "hi" } });

    await stepTranscribeSync(new Uint8Array([1]));
    expect(sync.headers()["X-AAI-Model"]).toBe(TRANSCRIBE_SYNC_MODEL);
    expect(sync.headers().Authorization).toBe("sk-test");
  });

  test("the body is multipart, carrying the filename it was given", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const sync = stubSync({ body: { text: "hi" } });

    await stepTranscribeSync(new Uint8Array([1]), { filename: "segment-04.wav" });
    expect(sync.headers()["Content-Type"]).toContain("multipart/form-data");
    const body = new TextDecoder().decode(sync.calls[0]?.init.body as Uint8Array);
    expect(body).toContain('filename="segment-04.wav"');
    expect(body).toContain("Content-Type: audio/wav");
  });

  test("a LIST body reaches the endpoint as one file, header and samples in order", async () => {
    // The shape a fan-out sends: a header written for a window, and the window,
    // handed over as two chunks so neither this call nor `multipartBody` has to
    // hold a joined copy of the segment. What the endpoint receives is the
    // ordinary multipart body — asserted on the BYTES between the part's header
    // terminator and the closing boundary, since that is the whole file it will
    // decode.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const sync = stubSync({ body: { text: "hi" } });

    const header = wavHeader({ sampleRate: 16_000 }, 4);
    const samples = new Uint8Array([0x00, 0x80, 0xff, 0x7f]);
    await stepTranscribeSync([header, samples], { filename: "segment-04.wav" });

    const body = sync.calls[0]?.init.body as Uint8Array;
    const boundary = /boundary=(.+)$/.exec(sync.headers()["Content-Type"] ?? "")?.[1] ?? "";
    const text = new TextDecoder("latin1").decode(body);
    const from = text.indexOf("\r\n\r\n") + 4;
    const to = text.lastIndexOf(`\r\n--${boundary}--`);
    expect(body.subarray(from, to)).toEqual(new Uint8Array([...header, ...samples]));
  });

  test("a silent segment answers with an empty string rather than throwing", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubSync({ body: {} });

    await expect(stepTranscribeSync(new Uint8Array([1]))).resolves.toEqual({ text: "" });
  });

  test("a failure is named by the caller's own label", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubSync({ status: 400, body: { message: "unsupported encoding" } });

    const err = await stepTranscribeSync(new Uint8Array([1]), {
      label: "segment 4 (0:40–1:20)",
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("segment 4 (0:40–1:20)");
    expect((err as Error).message).toContain("unsupported encoding");
    expect(err).toMatchObject({ retryable: false });
  });

  test("reads the endpoint's OTHER failure shape — `detail`, for auth and rate limits", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    stubSync({ status: 401, body: { detail: "Invalid API key" } });

    await expect(stepTranscribeSync(new Uint8Array([1]))).rejects.toThrow("Invalid API key");
  });
});
