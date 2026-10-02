// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createClaimer } from "./_upload-claims.ts";

const UPLOADS = "https://agents.example/a/uploads/upl_1";

/** A claimer over a stubbed `fetch`, recording the offsets each request claimed. */
function claimerOver(answer: () => Response, opts: { batch?: number } = {}) {
  const claimed: string[][] = [];
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    claimed.push(new URL(String(url)).searchParams.getAll("offset"));
    return answer();
  });
  vi.stubGlobal("fetch", fetch);
  const onFail = vi.fn();
  const claimer = createClaimer({
    uploads: UPLOADS,
    headers: { authorization: "Bearer t" },
    batch: opts.batch ?? 10,
    attempts: 1,
    signal: new AbortController().signal,
    fail: async (res) => new Error(`claim refused: ${res.status}`),
    onFail,
  });
  return { claimer, claimed, fetch, onFail };
}

describe("createClaimer", () => {
  test("claims every landed offset by the time drain resolves", async () => {
    const { claimer, claimed, fetch } = claimerOver(() => new Response(null, { status: 204 }));
    claimer.landed(0);
    claimer.landed(100);
    claimer.landed(200);
    await claimer.drain();
    expect(claimed.flat().sort()).toEqual(["0", "100", "200"]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^https:\/\/agents\.example\/a\/uploads\/upl_1\/parts\?offset=0/);
    expect(String(url)).toContain("&stored=1");
    expect(init).toMatchObject({ method: "PUT", headers: { authorization: "Bearer t" } });
  });

  test("never claims more than `batch` offsets in one request", async () => {
    const { claimer, claimed } = claimerOver(() => new Response(null, { status: 204 }), {
      batch: 2,
    });
    for (const offset of [0, 1, 2, 3, 4]) claimer.landed(offset);
    await claimer.drain();
    expect(claimed.flat()).toHaveLength(5);
    for (const request of claimed) expect(request.length).toBeLessThanOrEqual(2);
  });

  test("drain rejects with the caller's error for a refused claim, and reports it", async () => {
    const { claimer, onFail } = claimerOver(() => new Response(null, { status: 409 }));
    claimer.landed(0);
    await expect(claimer.drain()).rejects.toThrow("claim refused: 409");
    expect(onFail).toHaveBeenCalled();
  });

  test("drain with nothing landed sends nothing", async () => {
    const { claimer, fetch } = claimerOver(() => new Response(null, { status: 204 }));
    await claimer.drain();
    expect(fetch).not.toHaveBeenCalled();
  });
});
