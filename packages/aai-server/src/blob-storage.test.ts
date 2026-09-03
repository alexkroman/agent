// Copyright 2026 the AAI authors. MIT license.

import { isRecord } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  assertBucketPrivate,
  type BlobStorage,
  createMemoryBlobStorage,
  createSupabaseBlobStorage,
  storageEndpoint,
} from "./blob-storage.ts";
import { PlatformServiceUnavailableError } from "./platform-service-errors.ts";
import { captureLogs } from "./test-utils.ts";

/**
 * Every `code` down an error's `cause` chain.
 *
 * Reads the chain the way `error-handler.ts` does, rather than asserting on one
 * `cause` hop: what must hold is that the driver's code is REACHABLE from the
 * thrown error, and how many wrappers sit between them is storage-js's business.
 */
function causeCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === "string") codes.push(cur.code);
    cur = cur.cause;
  }
  return codes;
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/**
 * A fetch double recording what storage-js sent. Responses are keyed by
 * method so one double serves both a read and a write.
 */
function fakeFetch(handler: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(request?.headers ?? init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url,
      method: (request?.method ?? init?.method ?? "GET").toUpperCase(),
      headers,
      body: init?.body ?? null,
    };
    calls.push(call);
    // A handler that throws becomes a REJECTED promise, because that is what
    // `fetch` does — it never throws synchronously. Resolving `handler(call)`
    // directly let a sync throw escape past storage-js's own `.catch`, so a
    // network failure arrived at the caller as a raw `TypeError` instead of the
    // `StorageUnknownError` production really sees. A double that cannot
    // reproduce a network failure is the one shape this file most needs.
    try {
      return Promise.resolve(handler(call));
    } catch (err) {
      return Promise.reject(err);
    }
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function storage(handler: (call: Call) => Response): { store: BlobStorage; calls: Call[] } {
  const { fetch: fetchFn, calls } = fakeFetch(handler);
  const store = createSupabaseBlobStorage({
    url: "https://ref.supabase.co",
    serviceRoleKey: "service-role-key",
    bucket: "aai-blobs",
    fetch: fetchFn,
  });
  return { store, calls };
}

describe("storageEndpoint", () => {
  test("appends the storage API path", () => {
    expect(storageEndpoint("https://ref.supabase.co")).toBe("https://ref.supabase.co/storage/v1");
  });

  test("tolerates a trailing slash rather than doubling it", () => {
    expect(storageEndpoint("https://ref.supabase.co/")).toBe("https://ref.supabase.co/storage/v1");
  });
});

describe("createMemoryBlobStorage", () => {
  test("round-trips a blob and reports an unwritten key as a miss", async () => {
    const store = createMemoryBlobStorage();
    expect(await store.getItem("blobs/abc")).toBeNull();
    await store.setItem("blobs/abc", "worker code");
    expect(await store.getItem("blobs/abc")).toBe("worker code");
  });

  // Null here means "no URL exists", not "signing failed" — there is no
  // server in front of a Map. It is what keeps local dev and tests on the
  // byte path while production hands guests a URL.
  test("cannot sign, for a written key as much as an absent one", async () => {
    const store = createMemoryBlobStorage();
    await store.setItem("blobs/abc", "worker code");
    expect(await store.signedUrl("blobs/abc", 300)).toBeNull();
  });
});

describe("createSupabaseBlobStorage", () => {
  test("reads a blob from the bucket with the service-role key", async () => {
    const { store, calls } = storage(() => new Response("worker code", { status: 200 }));
    expect(await store.getItem("blobs/abc")).toBe("worker code");
    const [call] = calls;
    expect(call?.url).toContain("/storage/v1/object/aai-blobs/blobs/abc");
    expect(call?.headers.authorization).toBe("Bearer service-role-key");
    expect(call?.headers.apikey).toBe("service-role-key");
  });

  // The bundle store treats null and a throw very differently — a miss is
  // cached under a sentinel, a failure is retried — so this split is the
  // module's whole contract with it.
  test("resolves null for a missing object", async () => {
    const { store } = storage(
      () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );
    expect(await store.getItem("blobs/missing")).toBeNull();
  });

  test("throws on a server error rather than reporting a miss", async () => {
    const { store } = storage(() => new Response("boom", { status: 500 }));
    await expect(store.getItem("blobs/abc")).rejects.toThrow(/blob read failed for blobs\/abc/);
  });

  test("writes with upsert so a redeploy of identical content is not a conflict", async () => {
    const { store, calls } = storage(
      () => new Response(JSON.stringify({ Key: "ok" }), { status: 200 }),
    );
    await store.setItem("blobs/abc", "worker code");
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toContain("/storage/v1/object/aai-blobs/blobs/abc");
    expect(call?.headers["x-upsert"]).toBe("true");
  });

  /**
   * Storage stamps `Cache-Control` at UPLOAD time and never revisits it, so a
   * blob written today carries whatever was set today — forever. Content
   * hashes are the keys, so a year is correct by construction; leaving the
   * client's 3600 default in place would mean re-uploading the bucket the day
   * anything is served through the CDN.
   */
  test("writes a max-age matching the immutability the key already guarantees", async () => {
    const { store, calls } = storage(
      () => new Response(JSON.stringify({ Key: "ok" }), { status: 200 }),
    );
    await store.setItem("blobs/abc", "worker code");
    expect(calls[0]?.headers["cache-control"]).toBe("max-age=31536000");
  });

  test("throws when a write fails", async () => {
    const { store } = storage(() => new Response("nope", { status: 503 }));
    await expect(store.setItem("blobs/abc", "code")).rejects.toThrow(
      /blob write failed for blobs\/abc/,
    );
  });

  /**
   * The production shape: `POST /deploy` and two upload `PUT`s answered
   * `500 Internal server error` on `blob write failed … fetch failed`, during a
   * burst of thirty concurrent 8 MB uploads. A request that never got a
   * response is the most retryable failure there is, and 500 is the one answer
   * that tells a client not to bother — the studio client retries 5xx, so it
   * cost the retry too.
   */
  test("a write that never reached Storage is UNAVAILABLE, not a server fault", async () => {
    const { store } = storage(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    });
    const err = await store.setItem("blobs/abc", "code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformServiceUnavailableError);
    // And the reason survives. storage-js hangs the real failure on
    // `originalError`, which nothing walks — so before it was re-parented onto
    // `cause` the log said `fetch failed` and stopped, which is undici's
    // message for every network failure and names none of them.
    expect(String((err as Error).message)).toContain("blob write failed for blobs/abc");
    expect(JSON.stringify(causeCodes(err))).toContain("ECONNRESET");
  });

  test("a 429 is unavailable too — refusing now is not failing forever", async () => {
    const { store } = storage(() => new Response("slow down", { status: 429 }));
    await expect(store.setItem("blobs/abc", "code")).rejects.toBeInstanceOf(
      PlatformServiceUnavailableError,
    );
  });

  /**
   * The other side of the split, and the one that keeps 503 meaningful: a 4xx
   * will fail identically on retry, so telling the caller to retry it is worse
   * than telling it the truth. A 400 is a malformed key or a policy refusal —
   * ours to fix, not the network's.
   */
  test("a 4xx stays a plain failure, so nothing tells a caller to retry it", async () => {
    const { store } = storage(() => new Response("bad request", { status: 400 }));
    const err = await store.setItem("blobs/abc", "code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PlatformServiceUnavailableError);
  });

  test("signs a read URL for one object, scoped and expiring", async () => {
    const { store, calls } = storage(
      () => new Response(JSON.stringify({ signedURL: "/object/sign/aai-blobs/blobs/abc?token=t" })),
    );
    const url = await store.signedUrl("blobs/abc", 300);
    // Absolute, so the guest can fetch it with nothing but the string.
    expect(url).toBe("https://ref.supabase.co/storage/v1/object/sign/aai-blobs/blobs/abc?token=t");
    // And it carries a token rather than the service-role key it was minted
    // with — that key stays here, which is the point of handing out a URL.
    expect(url).not.toContain("service-role-key");
    const [call] = calls;
    expect(call?.url).toContain("/storage/v1/object/sign/aai-blobs/blobs/abc");
    expect(call?.body).toContain("300");
  });

  // Unlike getItem, a failed signing is never null: null means "this backend
  // cannot sign", and conflating the two would quietly put production back on
  // the byte path with nothing reporting it.
  test("throws when signing fails rather than reporting no URL", async () => {
    const { store } = storage(() => new Response("nope", { status: 500 }));
    await expect(store.signedUrl("blobs/abc", 300)).rejects.toThrow(
      /blob signing failed for blobs\/abc/,
    );
  });
});

/**
 * The bucket is the one piece of this platform's Supabase state that lives in
 * the dashboard rather than in `supabase/migrations`, so nothing else would
 * ever notice it going missing or turning public.
 */
describe("assertBucketPrivate", () => {
  const logs = captureLogs();

  const check = (handler: (call: Call) => Response) => {
    const { fetch: fetchFn, calls } = fakeFetch(handler);
    const run = assertBucketPrivate({
      url: "https://ref.supabase.co",
      serviceRoleKey: "service-role-key",
      bucket: "aai-blobs",
      fetch: fetchFn,
    });
    return { run, calls };
  };

  const bucketBody = (isPublic: boolean) =>
    new Response(JSON.stringify({ id: "aai-blobs", name: "aai-blobs", public: isPublic }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  test("passes a private bucket", async () => {
    const { run, calls } = check(() => bucketBody(false));
    await expect(run).resolves.toBeUndefined();
    expect(calls[0]?.url).toContain("/storage/v1/bucket/aai-blobs");
  });

  test("refuses a PUBLIC bucket", async () => {
    // Deploy artifacts are every tenant's worker bundles; the platform hands
    // them out through per-call signed URLs precisely so they are not
    // world-readable.
    const { run } = check(() => bucketBody(true));
    await expect(run).rejects.toThrow(/PUBLIC/);
  });

  test("refuses a bucket that does not exist", async () => {
    const { run } = check(() => new Response("{}", { status: 404 }));
    await expect(run).rejects.toThrow(/does not exist/);
  });

  /**
   * The asymmetry that makes this safe to await at boot: a configuration
   * error is fatal, a REACHABILITY failure is not. Failing boot on any error
   * would turn a Storage blip into every container refusing to start at once
   * — worse than the thing being guarded against.
   */
  test("a transient failure warns and lets the service boot", async () => {
    const { run } = check(() => new Response("upstream error", { status: 503 }));
    await expect(run).resolves.toBeUndefined();
    expect(logs.warns()).toEqual([expect.stringContaining("reachability")]);
  });
});
