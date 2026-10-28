// Copyright 2026 the AAI authors. MIT license.
// The `transcribe` for a `handleDictationRequest` route: the clip and headers
// go out, `{ text }` comes back, and a refusal surfaces the server's sentence.

import { describe, expect, test, vi } from "vitest";
import { dictationTranscriber } from "./dictation-transcriber.ts";

function replying(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const clip = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });
const signal = new AbortController().signal;

describe("dictationTranscriber", () => {
  test("posts the clip with its type and the headers, and answers the text", async () => {
    const send = replying(200, { text: "hello there" });
    let token = "one";
    const transcribe = dictationTranscriber("/api/dictation", {
      fetch: send,
      headers: () => ({ authorization: `Bearer ${token}` }),
    });

    expect(await transcribe(clip, { signal })).toBe("hello there");
    token = "two";
    await transcribe(clip, { signal });

    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe("/api/dictation");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(clip);
    expect(init?.signal).toBe(signal);
    expect(init?.headers).toMatchObject({ "Content-Type": "audio/wav" });
    // The header FUNCTION is read per request, so a rotated token is sent.
    expect(send.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer two" });
  });

  test("a refusal rejects with the server's own sentence", async () => {
    const transcribe = dictationTranscriber("/d", {
      fetch: replying(413, { error: "Recording too long — keep it under 120 seconds" }),
    });
    await expect(transcribe(clip, { signal })).rejects.toThrow("Recording too long");
  });

  test("a reply that is not the route's shape names the status", async () => {
    const transcribe = dictationTranscriber("/d", { fetch: replying(504, "<html>timeout</html>") });
    await expect(transcribe(clip, { signal })).rejects.toThrow("HTTP 504");
  });
});
