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

/** Decode the XML character entities S3 uses in `<Key>` values. */
function decodeXmlEntities(value: string): string {
  return (
    value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Both numeric forms, decoded with fromCodePoint: fromCharCode truncates
      // astral code points mod 2^16, and these are OBJECT KEYS — a truncated
      // decode is a different key, so deletes miss and listings show phantoms.
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, "&")
  );
}

type ListPage = { keys: string[]; nextToken: string | null };

function parseListPage(xml: string): ListPage {
  const body = /<ListBucketResult[^>]*>([\s\S]*)<\/ListBucketResult>/.exec(xml)?.[1];
  if (body == null) throw new Error("S3 list response missing <ListBucketResult>");
  const keys = [...body.matchAll(/<Contents[^>]*>([\s\S]*?)<\/Contents>/g)]
    .map((m) => /<Key>([\s\S]+?)<\/Key>/.exec(m[1] ?? "")?.[1])
    .filter((key): key is string => key != null)
    .map(decodeXmlEntities);
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(body);
  const nextToken = /<NextContinuationToken>([\s\S]+?)<\/NextContinuationToken>/.exec(body)?.[1];
  if (truncated && !nextToken) {
    throw new Error("S3 list response truncated without a continuation token");
  }
  return { keys, nextToken: truncated ? decodeXmlEntities(nextToken ?? "") : null };
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
