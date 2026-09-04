// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the platform's own upload-byte storage.
 *
 * Three things, and each of them is a decision rather than plumbing: the KEY a slug
 * composes (this is the one route that writes into a bucket shared by every tenant),
 * what a `readUrl` failure is allowed to look like, and that the memory arm answers
 * `null` rather than pretending it can sign.
 */

import { UPLOAD_KEY_PREFIX } from "@alexkroman1/aai-runtime";
import { describe, expect, test } from "vitest";
import { createMemoryUploadBytes, createSupabaseUploadBytes, uploadKey } from "./upload-bytes.ts";

/** A `fetch` that records and answers whatever a spec scripted. */
function scripted(answer: (url: string, init?: RequestInit) => Response) {
  const urls: string[] = [];
  const seam: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    return answer(String(input), init as RequestInit | undefined);
  };
  // `seam` is already declared as the thing, so it needs no cast — and `vi.fn` buys
  // nothing here: `urls` is the recording a spec asserts on.
  return { urls, fetch: seam };
}

const options = (fetch: typeof globalThis.fetch) => ({
  url: "https://ref.supabase.co",
  serviceRoleKey: "sb_secret_x",
  bucket: "artifacts",
  fetch,
});

describe("where an upload's window lives", () => {
  test("is the agent's slug under the uploads prefix, beside the deploy blobs", () => {
    // ONE bucket rather than two, which is safe only because `aai-sweep-blob-gc`
    // sweeps it per PREFIX: its blobs arm matches `name like 'blobs/%'` and would
    // otherwise delete every upload in the bucket on its first run, an upload
    // having no hash to be found by, while its uploads arm matches this prefix and
    // uses the `workflow_uploads` row as the referrer. Anything else put in this
    // bucket owes an arm of its own, or nothing ever reclaims it.
    expect(uploadKey("digest-desk", "upl_a", 8_388_608)).toBe("uploads/digest-desk/upl_a/8388608");
    // The root is the runtime's constant, so the two sides share one literal.
    expect(uploadKey("a", "b", 0).startsWith(`${UPLOAD_KEY_PREFIX}/`)).toBe(true);
    expect(uploadKey("a", "b", 0).startsWith("blobs/")).toBe(false);
  });
});

describe("the Supabase arm", () => {
  test("signs a per-object read URL", async () => {
    const script = scripted(() =>
      Response.json({ signedURL: "/object/sign/artifacts/uploads/a/b/0?token=t" }),
    );
    const bytes = createSupabaseUploadBytes(options(script.fetch));
    await expect(bytes.readUrl("uploads/a/b/0", 300)).resolves.toContain("token=t");
    expect(script.urls[0]).toContain("/storage/v1/object/sign/artifacts/uploads/a/b/0");
  });

  test("THROWS on a signing failure rather than answering null", async () => {
    // `null` is reserved for "this backend cannot sign at all" — the memory one. A
    // failure that resolved null would send the route down the byte-serving arm in
    // production, where the whole point of the redirect is that it does not.
    const script = scripted(() => Response.json({ error: "no" }, { status: 500 }));
    const bytes = createSupabaseUploadBytes(options(script.fetch));
    await expect(bytes.readUrl("uploads/a/b/0", 300)).rejects.toThrow(/signing failed/);
  });

  test("writes and measures through the SDK's own implementation", async () => {
    // The byte half is `createHttpUploadBackend`, so a guest brokering through this route
    // and a dev server talking to a bucket directly cannot diverge on how an object is
    // written — which is the whole reason it is not a second HTTP client here.
    const script = scripted((_url, init) =>
      init?.method === "HEAD"
        ? new Response("", { status: 200, headers: { "Content-Length": "16" } })
        : new Response("", { status: 200 }),
    );
    const bytes = createSupabaseUploadBytes(options(script.fetch));
    async function* body(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(16);
    }
    expect(await bytes.put("uploads/a/b/0", body())).toBe(16);
    expect(await bytes.size("uploads/a/b/0")).toBe(16);
    expect(script.urls.every((url) => url.includes("/object/artifacts/uploads/a/b/0"))).toBe(true);
  });
});

describe("the memory arm", () => {
  test("cannot sign, and says so with null rather than throwing", async () => {
    // There is no server in front of a Map. The route then serves the window itself,
    // which is exactly the behaviour that predates signing and the only path `aai dev`
    // and the tests ever take.
    const bytes = createMemoryUploadBytes();
    await expect(bytes.readUrl("uploads/a/b/0", 300)).resolves.toBeNull();
  });

  test("still round-trips a window, which is what makes it a usable arm", async () => {
    const bytes = createMemoryUploadBytes();
    async function* body(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([1, 2, 3, 4]);
    }
    expect(await bytes.put("uploads/a/b/0", body())).toBe(4);
    expect([...(await bytes.read("uploads/a/b/0", 1, 3))]).toEqual([2, 3]);
    expect(await bytes.size("uploads/a/b/0")).toBe(4);
  });
});
