// Copyright 2026 the AAI authors. MIT license.
/**
 * The dictation route as one `Request → Response`: the clip and key reach the
 * service, the body is capped before it is buffered (declared or counted), and
 * every refusal answers JSON a page can read.
 */

import { describe, expect, test, vi } from "vitest";
import { DICTATION_MAX_BYTES, type DictationFetch } from "./dictation.ts";
import { handleDictationRequest } from "./dictation-request.ts";

function service(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<DictationFetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
  );
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://x/dictation", {
    method: "POST",
    body,
    headers: { "Content-Type": "audio/wav", ...headers },
  });

/** A body with no `Content-Length`: the stream must be counted. */
function streamOf(bytes: number): ReadableStream<Uint8Array> {
  let left = bytes;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const n = Math.min(left, 64 * 1024);
      left -= n;
      controller.enqueue(new Uint8Array(n));
    },
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("handleDictationRequest", () => {
  test("forwards the clip under the given key and answers { text }", async () => {
    const send = service(200, { text: " add a weather tool " });
    const res = await handleDictationRequest(post(new Uint8Array([1, 2, 3])), {
      apiKey: "sk-user",
      fetch: send,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ text: "add a weather tool" });
    const init = send.mock.calls[0]?.[1];
    expect(init?.headers.Authorization).toBe("sk-user");
    expect(new TextDecoder().decode(init?.body)).toContain("Content-Type: audio/wav");
  });

  test("refuses anything but a POST", async () => {
    const send = service(200, { text: "no" });
    const res = await handleDictationRequest(new Request("http://x/dictation"), {
      apiKey: "k",
      fetch: send,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(send).not.toHaveBeenCalled();
  });

  test("an empty body is a 400 with no call", async () => {
    const send = service(200, { text: "no" });
    const res = await handleDictationRequest(post(null), { apiKey: "k", fetch: send });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  test("an oversized body is a 413, whether declared or only counted", async () => {
    const send = service(200, { text: "no" });
    const declared = await handleDictationRequest(
      post(new Uint8Array(1), { "Content-Length": String(DICTATION_MAX_BYTES + 1) }),
      { apiKey: "k", fetch: send },
    );
    expect(declared.status).toBe(413);

    const streamed = await handleDictationRequest(
      new Request("http://x/dictation", {
        method: "POST",
        body: streamOf(DICTATION_MAX_BYTES + 1),
        duplex: "half",
      } as RequestInit),
      { apiKey: "k", fetch: send },
    );
    expect(streamed.status).toBe(413);
    expect(String((await json(streamed)).error)).toContain("Recording too long");
    expect(send).not.toHaveBeenCalled();
  });

  test("the service's 429 stays a 429 and keeps its wait", async () => {
    const send = service(429, { detail: "slow down" }, { "Retry-After": "7" });
    const res = await handleDictationRequest(post(new Uint8Array([1])), {
      apiKey: "k",
      fetch: send,
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("any other refusal is a 502 naming it, and a missing key is the server's 500", async () => {
    const refused = await handleDictationRequest(post(new Uint8Array([1])), {
      apiKey: "k",
      fetch: service(401, { detail: "Invalid API key" }),
    });
    expect(refused.status).toBe(502);
    expect(String((await json(refused)).error)).toContain("Invalid API key");

    const unconfigured = await handleDictationRequest(post(new Uint8Array([1])), {
      apiKey: "",
      fetch: service(200, { text: "never" }),
    });
    expect(unconfigured.status).toBe(500);
  });
});
