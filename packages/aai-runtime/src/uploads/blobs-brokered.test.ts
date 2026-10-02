// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the BROKERED {@link UploadBackend}: window bytes sent through the
 * platform's upload route, carrying no credential of their own.
 *
 * Moved out of `blobs-http.test.ts`, whose Storage backend these mirror — the same
 * scripted `fetch`, the same request-shape assertions, so where the two differ (a
 * service key to a bucket versus nothing to a platform route) stays visible.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ScriptedCall as Call, scriptedFetch as scripted } from "../_fetch-test-utils.ts";
import { body, ramp } from "../_upload-store-test-utils.ts";
import { createBrokeredUploadBlobs } from "./blobs-brokered.ts";
import { UploadTooLargeError } from "./store.ts";

describe("brokered through the platform", () => {
  // VIRTUAL time, because this half retries and a spec that waits out a backoff is
  // both slow and a race — see `useVirtualTime` in `transports/`. Nothing else here
  // observes a clock, so the only cost is that a retrying spec has to advance one.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Past every backoff `BYTE_OP_ATTEMPTS` can spend, with room to spare. */
  const drainBackoff = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(5000);
  };

  /** The one answer a `size` spec wants: a measured window. */
  const okHead = (): Response =>
    new Response(null, { status: 200, headers: { "content-length": "64" } });

  const open = (answer: (call: Call) => Response) => {
    const script = scripted(answer);
    return {
      ...script,
      blobs: createBrokeredUploadBlobs({
        base: "https://platform.test/digest-desk/",
        fetch: script.fetch,
      }),
    };
  };

  /**
   * Like {@link open}, but the first `n` requests reject the way the network does.
   *
   * `TypeError: fetch failed` is undici's whole error for a reset, a refused
   * connection or a DNS blip — no status, no code on the value that is thrown —
   * which is why the classifier names the definite ANSWERS and treats the rest as
   * worth asking again.
   */
  const failing = (n: number, answer: (call: Call) => Response) => {
    let failed = 0;
    return open((call) => {
      if (failed >= n) return answer(call);
      failed += 1;
      throw new TypeError("fetch failed");
    });
  };

  test("sends only the LAST TWO segments of a key, and no credential", async () => {
    // The guest does not compose the prefix at all — the slug in the URL it was handed
    // IS the prefix, and the platform derives the key from that. Which is what makes it
    // unable to name another app's objects even in principle.
    const { blobs, calls } = open(() => new Response("{}", { status: 201 }));
    expect(await blobs.put("uploads/upl_a/8388608", body(ramp(16)))).toBe(16);
    const [call] = calls;
    expect(call?.url).toBe("https://platform.test/digest-desk/uploads/upl_a/8388608");
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.headers.apikey).toBeUndefined();
  });

  test("reads a window with the same inclusive last byte, following the redirect", async () => {
    // `redirect` is left at its default on purpose: following the platform's 302 to a
    // signed URL is the mechanism, and it is what keeps the bytes off the platform.
    const { blobs, calls } = open(() => new Response(ramp(4, 8), { status: 206 }));
    expect([...(await blobs.read("uploads/upl_a/0", 8, 12))]).toEqual([...ramp(4, 8)]);
    expect(calls[0]?.headers.range).toBe("bytes=8-11");
  });

  test("reads a HEAD with NO content-length as ABSENT, never as zero bytes", async () => {
    // The production bug, in one assertion. Node's `fetch` advertises `zstd`, the
    // platform's proxy honoured it on a body-less 200, and a `content-encoding: zstd`
    // response carries no `Content-Length` — measured against a deployed agent:
    // `identity`, `gzip` and `gzip, deflate, br` all answered `content-length:
    // 8388608` where `zstd` answered nothing. `Number(null)` is 0, a perfectly safe
    // non-negative integer, so this used to report a stored 8 MiB window as EMPTY and
    // `recordParts` recorded it as a zero-length hole.
    const { blobs } = open(
      () => new Response(null, { status: 200, headers: { "content-encoding": "zstd" } }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBeUndefined();
  });

  test("asks for the response UNENCODED, because the answer is a header", async () => {
    const { blobs, calls } = open(
      () => new Response(null, { status: 200, headers: { "content-length": "64" } }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBe(64);
    expect(calls[0]?.method).toBe("HEAD");
    expect(calls[0]?.headers["accept-encoding"]).toBe("identity");
  });

  test("still reports a genuinely EMPTY object as zero, not as absent", async () => {
    // The distinction the fix turns on: a stated `0` is a measurement, an absent
    // header is not. Collapsing them the other way would be the same bug mirrored.
    const { blobs } = open(
      () => new Response(null, { status: 200, headers: { "content-length": "0" } }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBe(0);
  });

  test("clamps 404 and 416, throws on anything else", async () => {
    for (const status of [404, 416]) {
      const { blobs } = open(() => new Response("", { status }));
      expect.soft([...(await blobs.read("uploads/upl_a/0", 0, 8))], String(status)).toEqual([]);
    }
    // A 503 is on `RETRYABLE_STATUS`, so it is re-issued before it is reported —
    // `settled` is awaited AFTER the clock so the rejection has a handler while the
    // backoff runs, and the assertion is still that the caller sees the status.
    const { blobs } = open(() => new Response("busy", { status: 503 }));
    const settled = expect(blobs.read("uploads/upl_a/0", 0, 8)).rejects.toThrow(/503/);
    await drainBackoff();
    await settled;
  });

  test("measures a window with a HEAD, and reads absence as undefined", async () => {
    const { blobs, calls } = open((call) =>
      call.url.endsWith("/0")
        ? new Response("", { status: 200, headers: { "Content-Length": "16" } })
        : new Response("", { status: 404 }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBe(16);
    expect(await blobs.size("uploads/upl_a/16")).toBeUndefined();
    expect(calls.every((call) => call.method === "HEAD")).toBe(true);
  });

  test("refuses a window past its limit before sending it", async () => {
    const { blobs, calls } = open(() => new Response("{}", { status: 201 }));
    await expect(
      blobs.put("uploads/upl_a/0", body(ramp(80)), { limit: 50 }),
    ).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(calls).toEqual([]);
  });

  test("tolerates a trailing slash on the base, which an operator sets", async () => {
    // Refusing one would be a boot failure over a character: this arrives from an
    // env var somebody typed. The `open` helper above passes a trailing slash for
    // exactly this reason, so every spec here covers it.
    const script = scripted(() => new Response("{}", { status: 201 }));
    const blobs = createBrokeredUploadBlobs({
      base: "https://platform.test/desk///",
      fetch: script.fetch,
    });
    await blobs.put("uploads/upl_a/0", body(ramp(1)));
    expect(script.calls[0]?.url).toBe("https://platform.test/desk/uploads/upl_a/0");
  });

  describe("re-issues what the network lost", () => {
    // The production failure this covers: `PUT …/workflows/uploads/<id>/parts -> 500`
    // twice on one upload, each preceded by `Workflow API request failed { error:
    // 'fetch failed' }`. A claim names up to `UPLOAD_CLAIM_BATCH` windows and
    // `recordParts` probes every one, all-or-nothing, so a single transient HEAD
    // failed a request that had already cost 5-16s.
    test("asks a failed HEAD again, which is what a claim's probes ride on", async () => {
      const { blobs, calls } = failing(1, okHead);
      const measured = blobs.size("uploads/upl_a/0");
      await drainBackoff();
      expect(await measured).toBe(64);
      expect(calls).toHaveLength(2);
    });

    test("re-sends a part, whose OFFSET is its name and so overwrites itself", async () => {
      // What makes the re-send legal rather than merely convenient: the key names the
      // byte the window starts at, so a second `PUT` of the same window is the same
      // object. The BODY is collected before the first attempt for the same reason it
      // has to be — a caller's stream drains once.
      const { blobs, calls } = failing(1, () => new Response("{}", { status: 201 }));
      const sent = blobs.put("uploads/upl_a/8388608", body(ramp(16)));
      await drainBackoff();
      expect(await sent).toBe(16);
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.bytes === 16)).toBe(true);
    });

    test("gives up after three, reporting what the transport said", async () => {
      const { blobs, calls } = failing(Number.POSITIVE_INFINITY, () => okHead());
      const settled = expect(blobs.size("uploads/upl_a/0")).rejects.toThrow(/fetch failed/);
      await drainBackoff();
      await settled;
      expect(calls).toHaveLength(3);
    });

    test("re-issues a transient STATUS, and reports a refusal at once", async () => {
      // `RETRYABLE_STATUS` is the SDK's own set, so the two ends of an upload cannot
      // disagree about which answers mean "come back".
      let answered = 0;
      const { blobs, calls } = open(() => {
        answered += 1;
        return answered <= 2 ? new Response("busy", { status: 503 }) : okHead();
      });
      const measured = blobs.size("uploads/upl_a/0");
      await drainBackoff();
      expect(await measured).toBe(64);
      expect(calls).toHaveLength(3);

      // A 403 is the platform's ANSWER — a `BrokerRefusal` — so it costs one request.
      const refused = open(() => new Response("nope", { status: 403 }));
      await expect(refused.blobs.size("uploads/upl_a/0")).rejects.toThrow(/403/);
      expect(refused.calls).toHaveLength(1);
    });

    test("never re-issues a TIMEOUT, which is the whole budget already spent", async () => {
      // Retrying one would make `BYTE_OP_TIMEOUT_MS` three times the bound it states,
      // and the bound exists to stop a hung socket parking a step.
      let issued = 0;
      const blobs = createBrokeredUploadBlobs({
        base: "https://platform.test/digest-desk/",
        fetch: () => {
          issued += 1;
          // Never settles: the timeout is the only thing that can end this.
          return new Promise<Response>(() => {
            // Deliberately nothing — a socket that opened and then went quiet.
          });
        },
      });
      const settled = expect(blobs.size("uploads/upl_a/0")).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(120_001);
      await drainBackoff();
      await settled;
      expect(issued).toBe(1);
    });

    test("ABORTS the timed-out request rather than leaving it on the pool", async () => {
      let seen: AbortSignal | undefined;
      const blobs = createBrokeredUploadBlobs({
        base: "https://platform.test/digest-desk/",
        fetch: (_input, init) => {
          seen = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        },
      });
      const settled = expect(blobs.size("uploads/upl_a/0")).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(120_001);
      await drainBackoff();
      await settled;
      expect(seen?.aborted).toBe(true);
    });
  });
});
