// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform upload-records backend: what it sends, and what it makes of the
 * answers.
 *
 * Driven through the injected `fetch`, so none of this needs a platform. What it is
 * really specifying is the WIRE — the field names both ends agree on, and the two
 * answers that are not failures.
 */

import { describe, expect, test } from "vitest";
import { fakeFetch } from "./_test-utils.ts";
import { UploadIdTakenError, UploadsUnavailableError } from "./_upload-store.ts";
import { createPlatformUploadRecords } from "./uploads-platform.ts";

/**
 * A fetch that records the bodies it was sent and answers `answer`.
 *
 * Built on `fakeFetch` from `_test-utils.ts`, which is where the ONE sanctioned
 * narrowing to `typeof globalThis.fetch` lives: a double never matches it
 * structurally, and the root guide's rule is one typed seam rather than a cast per
 * call site.
 */
function recordingFetch(answer: { status?: number; body?: unknown } = {}): {
  fetch: typeof globalThis.fetch;
  sent: () => Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  return {
    fetch: fakeFetch(async (_url, init) => {
      sent.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify(answer.body ?? { result: null }), {
        status: answer.status ?? 200,
      });
    }),
    sent: () => sent,
  };
}

const opts = (fetch: typeof globalThis.fetch) => ({
  base: "https://aai.example/my-agent",
  token: "guest-token",
  fetch,
});

describe("createPlatformUploadRecords", () => {
  test("ensure sends NOTHING, because there is nothing to ensure", async () => {
    // The seam's `ensure` exists for the Postgres backend's lazy `create table`.
    // The platform's schema is a migration, so a request here would be one wasted
    // round trip before EVERY other call — `ensure` is called before all of them.
    const { fetch, sent } = recordingFetch();
    await createPlatformUploadRecords(opts(fetch)).ensure();
    expect(sent()).toEqual([]);
  });

  test("posts the bearer and the method to the slug's own route", async () => {
    const seen: { url?: string | undefined; auth?: string | undefined } = {};
    const fetch = fakeFetch(async (url, init) => {
      seen.url = String(url);
      seen.auth = (init.headers as Record<string, string> | undefined)?.authorization;
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    });
    await createPlatformUploadRecords(opts(fetch)).finish("u1", 12);
    expect(seen.url).toBe("https://aai.example/my-agent/upload-records");
    expect(seen.auth).toBe("Bearer guest-token");
  });

  /**
   * A 409 is this backend WORKING, and must stay distinguishable.
   *
   * `claim` refusing a held id is what makes a caller-chosen id safe. Anything
   * else the store would treat as a transport failure — and a `claim` that
   * "failed" is retried, which would either loop or overwrite.
   */
  test("a 409 becomes UploadIdTakenError, not a generic failure", async () => {
    const { fetch } = recordingFetch({ status: 409, body: { error: "taken" } });
    const records = createPlatformUploadRecords(opts(fetch));
    await expect(
      records.claim("dup", { name: "", type: "", size: 0, complete: false, parts: [] }),
    ).rejects.toThrow(UploadIdTakenError);
  });

  test("a 501 becomes UploadsUnavailableError, so the route can answer 501", async () => {
    // The regression: this fell to the generic throw below, `sendUploadFailure`
    // did not recognise it, and every upload against a platform with no records
    // answered `500 Internal server error` with the actionable sentence left in
    // the platform's log. The class exists precisely to stop that.
    const { fetch } = recordingFetch({
      status: 501,
      body: { error: "platform upload records not configured" },
    });
    const records = createPlatformUploadRecords(opts(fetch));
    await expect(records.finish("u1", 1)).rejects.toThrow(UploadsUnavailableError);
  });

  test("the 501 message names the condition and how to supply it", async () => {
    // The message IS the value here — it is what reaches a browser in the 501
    // body, so it has to name the missing thing rather than the failed call.
    const { fetch } = recordingFetch({ status: 501, body: { error: "nope" } });
    await expect(createPlatformUploadRecords(opts(fetch)).read("u1")).rejects.toThrow(
      /no workflow upload records configured[\s\S]*SUPABASE_DB_URL/,
    );
  });

  test("a 501 is NOT reported as a generic HTTP failure", async () => {
    // Guards the ordering: a `!res.ok` branch placed first would still throw,
    // with the status in the text and the class lost — which passes a naive
    // "it rejects" assertion while restoring the exact bug.
    const { fetch } = recordingFetch({ status: 501, body: { error: "nope" } });
    await expect(createPlatformUploadRecords(opts(fetch)).read("u1")).rejects.not.toThrow(
      /answered HTTP 501/,
    );
  });

  test("any other non-2xx throws, naming the status", async () => {
    // No fallback above this: a swallowed failure means bytes in the bucket behind
    // a record that says nothing arrived.
    const { fetch } = recordingFetch({ status: 503, body: { error: "nope" } });
    await expect(createPlatformUploadRecords(opts(fetch)).finish("u1", 1)).rejects.toThrow(/503/);
  });

  test("a 200 without a result throws rather than reading as empty", async () => {
    const { fetch } = recordingFetch({ body: { ok: true } });
    await expect(createPlatformUploadRecords(opts(fetch)).read("u1")).rejects.toThrow(
      /without a result/,
    );
  });

  test("read maps null to undefined — no record is not a malformed one", async () => {
    const { fetch } = recordingFetch({ body: { result: null } });
    expect(await createPlatformUploadRecords(opts(fetch)).read("u1")).toBeUndefined();
  });

  test("read keeps expected ABSENT when the platform omits it", async () => {
    // The same distinction the SQL side pins: absent means "not a parts upload",
    // which decides how completion is judged.
    const { fetch } = recordingFetch({
      body: { result: { name: "a", type: "b", size: 4, complete: false, parts: [] } },
    });
    const held = await createPlatformUploadRecords(opts(fetch)).read("u1");
    expect(held && "expected" in held).toBe(false);
  });

  test("read refuses a record whose size is not a number", async () => {
    // `typeof`, never `Number(...)`: a size that reads 0 instead of unreadable is an
    // upload the store believes is empty.
    const { fetch } = recordingFetch({
      body: { result: { name: "a", type: "b", size: null, complete: true, parts: [] } },
    });
    expect(await createPlatformUploadRecords(opts(fetch)).read("u1")).toBeUndefined();
  });

  test("read DROPS a malformed window rather than failing the whole record", async () => {
    // A corrupt entry would make an upload unreadable forever; a missing window
    // only shortens the readable prefix, and a resumed transfer asks again.
    const { fetch } = recordingFetch({
      body: {
        result: {
          name: "a",
          type: "b",
          size: 8,
          complete: false,
          parts: [{ at: 0, bytes: 8 }, { at: "nope", bytes: 4 }, { bytes: 2 }],
        },
      },
    });
    const held = await createPlatformUploadRecords(opts(fetch)).read("u1");
    expect(held?.parts).toEqual([{ at: 0, bytes: 8 }]);
  });

  test("claim omits expected entirely when the record has none", async () => {
    // Sending `expected: null` would make the platform store a declared total of
    // nothing, which is a DIFFERENT upload kind from one that declared none.
    const { fetch, sent } = recordingFetch();
    await createPlatformUploadRecords(opts(fetch)).claim("u1", {
      name: "a",
      type: "b",
      size: 0,
      complete: false,
      parts: [],
    });
    const body = sent()[0];
    expect(body).toBeDefined();
    expect(body && "expected" in body).toBe(false);
  });

  test("claim sends expected when the record declares one", async () => {
    const { fetch, sent } = recordingFetch();
    await createPlatformUploadRecords(opts(fetch)).claim("u1", {
      name: "a",
      type: "b",
      size: 0,
      complete: false,
      expected: 900,
      parts: [],
    });
    expect(sent()[0]).toMatchObject({ method: "claim", id: "u1", expected: 900 });
  });

  test("update sends only the three things a window arrival can change", async () => {
    // Not the declaration: an update carrying `name`/`expected` would let a late
    // window silently redeclare the upload.
    const { fetch, sent } = recordingFetch();
    await createPlatformUploadRecords(opts(fetch)).update("u1", {
      size: 16,
      complete: true,
      parts: [{ at: 0, bytes: 16 }],
    });
    const body = sent()[0] ?? {};
    expect(body).toMatchObject({ method: "update", id: "u1", size: 16, complete: true });
    expect("name" in body).toBe(false);
    expect("expected" in body).toBe(false);
  });
});
