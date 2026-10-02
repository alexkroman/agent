// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the Storage REST {@link UploadBackend}; its brokered sibling's are in
 * `blobs-brokered.test.ts`.
 *
 * Both backends are one thin layer over `fetch` and the whole subject is the REQUEST each
 * operation composes — the `Range` header's inclusive last byte against every offset
 * in this codebase being half-open, the `x-upsert` that makes a retried part the same
 * object, and which statuses mean "less than you asked for" rather than "broken". A
 * scripted `fetch` is the only thing that can see any of it.
 *
 * Where the two differ is the interesting property — this one carries a service key to
 * a bucket, the brokered one carries nothing to a platform route, and that split is the
 * security boundary (`blobs.ts`, "Signing is NOT here") — so both specs share one
 * scripted `fetch` (`../_fetch-test-utils.ts`) and the same request vocabulary.
 */

import { describe, expect, test } from "vitest";
import { type ScriptedCall as Call, scriptedFetch as scripted } from "../_fetch-test-utils.ts";
import { body, ramp } from "../_upload-store-test-utils.ts";
import { createHttpUploadBackend, storageEndpoint } from "./blobs-http.ts";
import { UploadTooLargeError } from "./store.ts";

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
      expect.soft([...(await blobs.read("uploads/upl_a/0", 0, 8))], String(status)).toEqual([]);
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
