// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { RETRYABLE_STATUS, withRetries } from "./_upload-retry.ts";

/** A "come back" that names a zero delay, so a retry costs no wall-clock time. */
const comeBackNow = () => new Response(null, { status: 503, headers: { "Retry-After": "0" } });
const live = () => new AbortController().signal;

describe("withRetries", () => {
  test("answers the first success, counting the attempt", async () => {
    const issue = vi.fn(async () => new Response("ok"));
    const { res, attempts } = await withRetries(issue, { attempts: 3, signal: live() });
    expect(await res.text()).toBe("ok");
    expect(attempts).toBe(1);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  test("re-issues a retryable status until it succeeds", async () => {
    const issue = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(comeBackNow())
      .mockResolvedValueOnce(new Response("ok"));
    const { res, attempts } = await withRetries(issue, { attempts: 3, signal: live() });
    expect(res.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("answers a refusal at once — it would be a refusal again", async () => {
    const issue = vi.fn(async () => new Response(null, { status: 403 }));
    const { res, attempts } = await withRetries(issue, { attempts: 5, signal: live() });
    expect(res.status).toBe(403);
    expect(attempts).toBe(1);
  });

  test("hands back the last 'come back' once the budget is out, for the caller to word", async () => {
    const issue = vi.fn(async () => comeBackNow());
    const { res, attempts } = await withRetries(issue, { attempts: 3, signal: live() });
    expect(res.status).toBe(503);
    expect(attempts).toBe(3);
    expect(issue).toHaveBeenCalledTimes(3);
  });

  test("retries a transport failure, and re-throws it when the budget is out", async () => {
    const lost = new TypeError("fetch failed");
    const issue = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(lost)
      .mockResolvedValueOnce(new Response("ok"));
    await expect(withRetries(issue, { attempts: 2, signal: live() })).resolves.toMatchObject({
      attempts: 2,
    });
    await expect(
      withRetries(() => Promise.reject(lost), { attempts: 1, signal: live() }),
    ).rejects.toBe(lost);
  });

  test("re-throws at once on an abort, which is an answer rather than a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const issue = vi.fn(() => Promise.reject(new Error("aborted")));
    await expect(withRetries(issue, { attempts: 5, signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
    expect(issue).toHaveBeenCalledTimes(1);
  });

  test("RETRYABLE_STATUS holds the 'come back' answers and no refusal", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(RETRYABLE_STATUS.has(status), String(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 413]) {
      expect(RETRYABLE_STATUS.has(status), String(status)).toBe(false);
    }
  });
});
