// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /studio/dictation` through the whole studio app, against a fake
 * dictation API: it is authenticated, the clip goes out under the CALLER's
 * key, the SDK handler's refusals come back readable, and the route is metered
 * per caller. The handler's own edges (cap, empty body, 405) are pinned by
 * `aai`'s `dictation-request.test.ts`; one of them is checked here to prove the
 * route mounts it.
 */

import { DICTATION_MAX_BYTES, type DictationFetch } from "@alexkroman1/aai/experimental";
import { createRateLimiter } from "aai-server/http";
import { authHeaders } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";

function service(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<DictationFetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
  );
}

async function mount(dictationFetch: DictationFetch, limit?: number) {
  const { fetch } = await createTestCombined({
    dictationFetch,
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

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? "";
}

describe("POST /studio/dictation", () => {
  test("transcribes the clip on the caller's own key", async () => {
    const api = service(200, { text: "add a weather tool" });
    const { post } = await mount(api);

    const res = await post(CLIP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "add a weather tool" });
    expect(api.mock.calls[0]?.[1]?.headers.Authorization).toBe("key1");
  });

  test("requires a signed-in caller", async () => {
    const api = service(200, { text: "never" });
    const { post } = await mount(api);
    expect((await post(CLIP, {})).status).toBe(401);
    expect(api).not.toHaveBeenCalled();
  });

  test("the SDK handler's cap is mounted: an oversized clip is a 413 with no call", async () => {
    const api = service(200, { text: "never" });
    const { post } = await mount(api);
    const huge = await post(new Uint8Array(DICTATION_MAX_BYTES + 1));
    expect(huge.status).toBe(413);
    expect(await errorOf(huge)).toContain("Recording too long");
    expect(api).not.toHaveBeenCalled();
  });

  test("a refusal from the service reads as one, and a rate limit keeps its status", async () => {
    const refused = await mount(service(401, { detail: "Invalid API key" }));
    const res = await refused.post(CLIP);
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toContain("Invalid API key");

    const limited = await mount(service(429, { detail: "slow down" }, { "Retry-After": "5" }));
    const busy = await limited.post(CLIP);
    expect(busy.status).toBe(429);
    expect(Number(busy.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("is metered per caller", async () => {
    const api = service(200, { text: "hi" });
    const { post } = await mount(api, 1);
    expect((await post(CLIP)).status).toBe(200);
    expect((await post(CLIP)).status).toBe(429);
    expect(api).toHaveBeenCalledOnce();
  });
});
