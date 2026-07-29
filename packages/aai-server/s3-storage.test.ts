// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createS3Storage, type S3StorageOptions } from "./s3-storage.ts";

const BASE_OPTS = {
  bucket: "test-bucket",
  endpoint: "https://fly.storage.tigris.dev",
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
    expect(url.origin).toBe("https://fly.storage.tigris.dev");
    expect(url.pathname).toBe("/test-bucket");
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
