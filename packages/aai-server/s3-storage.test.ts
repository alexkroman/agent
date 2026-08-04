// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createS3Storage, type S3StorageOptions } from "./s3-storage.ts";

const BASE_OPTS = {
  bucket: "test-bucket",
  endpoint: "https://example.supabase.co/storage/v1/s3",
  region: "auto",
  accessKeyId: "AKIATEST",
  secretAccessKey: "secret",
} satisfies Omit<S3StorageOptions, "fetch">;

function listPage(opts: { keys: string[]; nextToken?: string }): string {
  const contents = opts.keys
    .map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
    .join("");
  const truncation = opts.nextToken
    ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${opts.nextToken}</NextContinuationToken>`
    : "<IsTruncated>false</IsTruncated>";
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${truncation}${contents}</ListBucketResult>`;
}

/** Storage backed by a fake S3 that serves canned list pages and records requests. */
function storageWithPages(pages: string[]) {
  const requests: URL[] = [];
  let call = 0;
  const storage = createS3Storage({
    ...BASE_OPTS,
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      const body = pages[call] ?? listPage({ keys: [] });
      call += 1;
      return new Response(body, { status: 200 });
    },
  });
  return { storage, requests };
}

describe("createS3Storage getKeys", () => {
  test("sends a ListObjectsV2 request with the prefix", async () => {
    const { storage, requests } = storageWithPages([
      listPage({ keys: ["studio/scope-a/demo", "studio/scope-a/other"] }),
    ]);

    const keys = await storage.getKeys("studio/scope-a/");

    expect(requests).toHaveLength(1);
    const url = requests[0] as URL;
    expect(url.origin).toBe("https://example.supabase.co");
    // A path-ful endpoint (Supabase's S3-compatible API) must keep its base
    // path — the bucket is appended, not resolved against the origin.
    expect(url.pathname).toBe("/storage/v1/s3/test-bucket");
    expect(url.searchParams.get("list-type")).toBe("2");
    // unstorage normalizes the base to `studio:scope-a:`; the driver must
    // convert it back to a `/`-separated S3 prefix with the trailing slash
    // intact so `scope-a` never matches `scope-ax`.
    expect(url.searchParams.get("prefix")).toBe("studio/scope-a/");
    expect(keys.sort()).toEqual(["studio:scope-a:demo", "studio:scope-a:other"]);
  });

  test("follows continuation tokens across pages", async () => {
    const { storage, requests } = storageWithPages([
      listPage({ keys: ["studio/s/p1"], nextToken: "token-1" }),
      listPage({ keys: ["studio/s/p2"], nextToken: "token-2" }),
      listPage({ keys: ["studio/s/p3"] }),
    ]);

    const keys = await storage.getKeys("studio/s/");

    expect(requests).toHaveLength(3);
    expect((requests[1] as URL).searchParams.get("continuation-token")).toBe("token-1");
    expect((requests[2] as URL).searchParams.get("continuation-token")).toBe("token-2");
    expect(keys.sort()).toEqual(["studio:s:p1", "studio:s:p2", "studio:s:p3"]);
  });

  test("keys outside the requested base are filtered out", async () => {
    // The prefix narrows the server-side listing, but core still filters —
    // a backend that ignores `prefix` must not leak sibling scopes.
    const { storage } = storageWithPages([
      listPage({ keys: ["studio/scope-a/demo", "studio/scope-ax/evil", "agents/foo/manifest"] }),
    ]);

    const keys = await storage.getKeys("studio/scope-a/");

    expect(keys).toEqual(["studio:scope-a:demo"]);
  });

  test("decodes XML entities in keys", async () => {
    const { storage } = storageWithPages([listPage({ keys: ["studio/s/a&amp;b"] })]);

    const keys = await storage.getKeys("studio/s/");

    expect(keys).toEqual(["studio:s:a&b"]);
  });

  test("decodes numeric entities — hex form and astral code points — in keys", async () => {
    // These are object keys: a truncated decode is a DIFFERENT key, so
    // deletes miss and listings show phantoms. fromCharCode would fold
    // U+1F600 to a lone surrogate; the hex form used to pass through raw.
    const { storage } = storageWithPages([
      listPage({ keys: ["studio/s/a&#128512;b", "studio/s/c&#x1F600;d", "studio/s/e&#233;f"] }),
    ]);

    const keys = await storage.getKeys("studio/s/");

    expect(keys).toEqual(["studio:s:a\u{1F600}b", "studio:s:c\u{1F600}d", "studio:s:eéf"]);
  });

  test("throws on a non-OK list response instead of returning []", async () => {
    const storage = createS3Storage({
      ...BASE_OPTS,
      fetch: async () => new Response("AccessDenied", { status: 403, statusText: "Forbidden" }),
    });

    await expect(storage.getKeys("studio/s/")).rejects.toThrow(/S3 list failed: 403/);
  });

  test("throws on a truncated response with no continuation token", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>studio/s/p</Key></Contents></ListBucketResult>`;
    const storage = createS3Storage({
      ...BASE_OPTS,
      fetch: async () => new Response(xml, { status: 200 }),
    });

    await expect(storage.getKeys("studio/s/")).rejects.toThrow(/truncated without a continuation/);
  });

  test("getKeys with no base lists the whole bucket without a prefix param", async () => {
    const { storage, requests } = storageWithPages([listPage({ keys: ["agents/foo/manifest"] })]);

    const keys = await storage.getKeys();

    expect((requests[0] as URL).searchParams.has("prefix")).toBe(false);
    expect(keys).toEqual(["agents:foo:manifest"]);
  });
});
