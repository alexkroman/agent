// Copyright 2025 the AAI authors. MIT license.
/**
 * Production storage: unstorage's S3 driver (generic SigV4 — Supabase
 * Storage's S3-compatible endpoint in production) with a working `getKeys`.
 *
 * The stock driver's `getKeys` lists the WHOLE bucket — it never sends a
 * `prefix` parameter — and reads only the first ListObjects page (S3 caps a
 * page at 1000 keys, and the driver never follows the continuation token).
 * unstorage core then filters the returned keys by prefix client-side, so
 * once the bucket holds >1000 objects, keys that sort past the first page
 * simply vanish from every listing. (When workspaces still lived in this
 * bucket that emptied the studio project picker in production; today the
 * bucket holds only content-addressed `blobs/…` deploy artifacts, but any
 * key listing would silently truncate the same way.)
 *
 * This module keeps the stock driver for everything else and replaces only
 * `getKeys` with a signed ListObjectsV2 loop that passes the prefix and
 * follows `NextContinuationToken` until the listing is complete.
 */

import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import { createStorage, type Storage } from "unstorage";
import s3Driver from "unstorage/drivers/s3";

export type S3StorageOptions = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Test seam — production always uses global fetch. */
  fetch?: typeof globalThis.fetch;
};

/**
 * unstorage hands drivers the base in normalized `:`-separated form (e.g.
 * `studio:scope:`); S3 object keys use `/`. A trailing separator is
 * significant — it keeps `studio/scope/…` from matching `studio/scopeX/…`.
 */
function toS3Prefix(base: string | undefined): string {
  return (base ?? "").replace(/:/g, "/");
}

/**
 * Values arrive as untrimmed strings, byte-for-byte: these are OBJECT KEYS,
 * where a trimmed or type-coerced decode is a DIFFERENT key, so deletes miss
 * and listings show phantoms. `htmlEntities` is what turns on numeric
 * character references (`&#…;`/`&#x…;`), which the parser decodes with
 * `fromCodePoint` — `fromCharCode` would truncate astral code points.
 */
const listParser = new XMLParser({
  parseTagValue: false,
  trimValues: false,
  htmlEntities: true,
  // A page with a single object yields a lone <Contents> element, which
  // would otherwise parse as an object rather than a one-element array.
  isArray: (_name, jPath) => jPath === "ListBucketResult.Contents",
});

type ListPage = { keys: string[]; nextToken: string | null };

type ListBucketResult = {
  Contents?: Array<{ Key?: unknown }>;
  IsTruncated?: unknown;
  NextContinuationToken?: unknown;
};

function parseListPage(xml: string): ListPage {
  const result: unknown = listParser.parse(xml)?.ListBucketResult;
  if (result == null || typeof result !== "object") {
    throw new Error("S3 list response missing <ListBucketResult>");
  }
  const page = result as ListBucketResult;
  const keys = (page.Contents ?? [])
    .map((contents) => contents?.Key)
    .filter((key): key is string => typeof key === "string");
  const truncated = String(page.IsTruncated).trim() === "true";
  const nextToken =
    typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : null;
  if (truncated && !nextToken) {
    throw new Error("S3 list response truncated without a continuation token");
  }
  return { keys, nextToken: truncated ? nextToken : null };
}

/** All object keys under `prefix`, following continuation tokens. */
async function listAllKeys(
  options: S3StorageOptions,
  client: AwsClient,
  base: string | undefined,
): Promise<string[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const bucketUrl = `${options.endpoint.replace(/\/$/, "")}/${options.bucket}`;
  const prefix = toS3Prefix(base);

  const keys: string[] = [];
  let token: string | null = null;
  do {
    const url = new URL(bucketUrl);
    url.searchParams.set("list-type", "2");
    if (prefix) url.searchParams.set("prefix", prefix);
    if (token) url.searchParams.set("continuation-token", token);
    const request = await client.sign(url.toString(), { method: "GET" });
    const res = await doFetch(request);
    if (!res.ok) {
      // Loud, not empty: an "[]" here reads as data loss to every caller
      // (empty project picker, "nothing to wipe" on agent delete).
      throw new Error(`S3 list failed: ${res.status} ${res.statusText} ${await res.text()}`);
    }
    const page = parseListPage(await res.text());
    keys.push(...page.keys);
    token = page.nextToken;
  } while (token);
  return keys;
}

/**
 * S3-backed unstorage `Storage` with prefixed, paginated key listing.
 * Everything except `getKeys` is the stock unstorage S3 driver.
 */
export function createS3Storage(options: S3StorageOptions): Storage {
  const driver = s3Driver({
    bucket: options.bucket,
    endpoint: options.endpoint,
    region: options.region,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
  });
  // One signing client for the store's lifetime — credentials and region
  // are fixed at creation.
  const client = new AwsClient({
    service: "s3",
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
  });
  return createStorage({
    driver: {
      ...driver,
      getKeys: (base) => listAllKeys(options, client, base),
    },
  });
}
