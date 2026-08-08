// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  type BlobStorage,
  createMemoryBlobStorage,
  createSupabaseBlobStorage,
  storageEndpoint,
} from "./blob-storage.ts";

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
    return Promise.resolve(handler(call));
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
