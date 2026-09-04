// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the two real {@link UploadBackend} implementations.
 *
 * Both are one thin layer over `fetch` and the whole subject is the REQUEST each
 * operation composes — the `Range` header's inclusive last byte against every offset
 * in this codebase being half-open, the `x-upsert` that makes a retried part the same
 * object, and which statuses mean "less than you asked for" rather than "broken". A
 * scripted `fetch` is the only thing that can see any of it.
 *
 * The two are asserted TOGETHER because the interesting property is where they differ:
 * one carries a service key to a bucket, the other carries nothing to a platform route,
 * and that split is the security boundary (`_upload-blobs.ts`, "Signing is NOT here").
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBrokeredUploadBlobs } from "./_upload-blobs-brokered.ts";
import { createHttpUploadBackend, storageEndpoint } from "./_upload-blobs-http.ts";
import { UploadTooLargeError } from "./_upload-store.ts";

/** One request the implementation made, reduced to what a spec asks about. */
type Call = { method: string; url: string; headers: Record<string, string>; bytes: number };

/** A `fetch` that records and answers whatever a spec scripted. */
function scripted(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const body = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      bytes: body instanceof Uint8Array ? body.length : 0,
    };
    calls.push(call);
    return answer(call);
  });
  // `vi.mocked`-free and cast-free: the seam is typed as `typeof globalThis.fetch`, so
  // the fake is DECLARED as one rather than laundered into one — a cast here would stop
  // reporting the moment either signature moved.
  const seam: typeof globalThis.fetch = async (input, init) =>
    await fetch(String(input), init as RequestInit | undefined);
  return { calls, fetch: seam };
}

async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}

const ramp = (n: number, from = 0): Uint8Array =>
  Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);

describe("Storage over its REST API", () => {
  const open = (answer: (call: Call) => Response) => {
    const script = scripted(answer);
    return {
      ...script,
      blobs: createHttpUploadBackend({
        url: "https://ref.supabase.co/",
        serviceKey: "sb_secret_x",
        bucket: "artifacts",
        fetch: script.fetch,
      }),
    };
  };

  test("PUTs one object, upserting, with the key percent-encoded per segment", async () => {
    const { blobs, calls } = open(() => new Response("", { status: 200 }));
    expect(
      await blobs.put("uploads/upl_a/0", body(ramp(4), ramp(6, 4)), { type: "audio/wav" }),
    ).toBe(10);
    const [call] = calls;
    expect(call?.method).toBe("PUT");
    expect(call?.url).toBe("https://ref.supabase.co/storage/v1/object/artifacts/uploads/upl_a/0");
    // Upsert, because a part is RETRIED whenever a connection dies mid-flight: without
    // it Storage 409s the second attempt and the ordinary failure the parts path exists
    // to survive becomes permanent.
    expect(call?.headers["x-upsert"]).toBe("true");
    expect(call?.headers["content-type"]).toBe("audio/wav");
    expect(call?.headers.authorization).toBe("Bearer sb_secret_x");
    // The length is what ARRIVED, not what a header declared.
    expect(call?.bytes).toBe(10);
  });

  test("refuses a body past its limit AS IT ARRIVES, without writing", async () => {
    const { blobs, calls } = open(() => new Response("", { status: 200 }));
    await expect(
      blobs.put("uploads/upl_a/0", body(ramp(40), ramp(40, 40)), { limit: 50 }),
    ).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(calls).toEqual([]);
  });

  test("asks for a window with an INCLUSIVE last byte", async () => {
    // The one place this codebase's half-open ranges meet HTTP's inclusive ones, and an
    // off-by-one here reads back as a corrupt file with no error anywhere.
    const { blobs, calls } = open(() => new Response(ramp(4, 8), { status: 206 }));
    expect([...(await blobs.read("uploads/upl_a/0", 8, 12))]).toEqual([...ramp(4, 8)]);
    expect(calls[0]?.headers.range).toBe("bytes=8-11");
  });

  test("asks for nothing when the window is empty", async () => {
    const { blobs, calls } = open(() => new Response("", { status: 500 }));
    expect([...(await blobs.read("uploads/upl_a/0", 8, 8))]).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("answers SHORT for 404 and 416, and THROWS for anything else", async () => {
    // Clamped rather than refused — the behaviour `stepReadUpload` has always had, so a plan
    // computed from a header may end one byte past the file. A 5xx is a different claim
    // and must not read as "there is nothing there".
    for (const status of [404, 416]) {
      const { blobs } = open(() => new Response("", { status }));
      expect([...(await blobs.read("uploads/upl_a/0", 0, 8))]).toEqual([]);
    }
    const { blobs } = open(() => new Response("boom", { status: 503 }));
    await expect(blobs.read("uploads/upl_a/0", 0, 8)).rejects.toThrow(/503/);
  });

  test("measures an object with a HEAD, and reads absence as undefined", async () => {
    const { blobs, calls } = open((call) =>
      call.url.endsWith("/0")
        ? new Response("", { status: 200, headers: { "Content-Length": "8" } })
        : new Response("", { status: 404 }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBe(8);
    expect(await blobs.size("uploads/upl_a/8")).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
  });

  test("reads an UNMEASURABLE answer as absent, never as a guess", async () => {
    // `size` is the whole defence against a part nobody uploaded, so it must never
    // over-report: a length it cannot parse is "cannot say", which the store treats as
    // "not there" rather than recording a hole as present.
    const { blobs } = open(
      () => new Response("", { status: 200, headers: { "Content-Length": "lots" } }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBeUndefined();
  });

  test("but an EMPTY object really is zero bytes", async () => {
    // The other side of the same rule: 0 is a measurement, not a failure to measure.
    // A parts upload of no bytes is complete from its declaration, so nothing downstream
    // is waiting on a window that will never come.
    const { blobs } = open(
      () => new Response("", { status: 200, headers: { "Content-Length": "0" } }),
    );
    expect(await blobs.size("uploads/upl_a/0")).toBe(0);
  });

  test("names the BUCKET when there is none, rather than repeating a 404", async () => {
    // The first wall a developer meets after setting three env vars, and the raw answer
    // does not help: `404 {"error":"Bucket not found"}` reads as "that object is not
    // there". A bucket is dashboard state rather than a migration, so nothing creates it
    // and nothing else would ever mention it.
    const { blobs } = open(
      () => new Response(JSON.stringify({ error: "Bucket not found" }), { status: 404 }),
    );
    await expect(blobs.put("uploads/upl_a/0", body(ramp(4)))).rejects.toThrow(
      /AAI_UPLOAD_STORAGE_BUCKET/,
    );
    await expect(blobs.put("uploads/upl_a/0", body(ramp(4)))).rejects.toThrow(/PRIVATE bucket/);
  });

  test("still reads a MISSING OBJECT as short, which is a different 404", async () => {
    // The two 404s must not be conflated in either direction: an absent object is the
    // clamp `stepReadUpload` relies on, and an absent bucket is a configuration fault.
    const { blobs } = open(() => new Response("", { status: 404 }));
    expect([...(await blobs.read("uploads/upl_a/0", 0, 8))]).toEqual([]);
    expect(await blobs.size("uploads/upl_a/0")).toBeUndefined();
  });

  test("appends the Storage path to a project URL, trailing slash or not", () => {
    expect(storageEndpoint("https://ref.supabase.co")).toBe("https://ref.supabase.co/storage/v1");
    expect(storageEndpoint("https://ref.supabase.co//")).toBe("https://ref.supabase.co/storage/v1");
  });
});

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
      expect([...(await blobs.read("uploads/upl_a/0", 0, 8))]).toEqual([]);
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
  });
});
