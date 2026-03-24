// Copyright 2025 the AAI authors. MIT license.
/**
 * AaiR2Bucket implementation backed by S3-compatible storage via aws4fetch.
 *
 * @module
 */

import { AwsClient } from "aws4fetch";
import type { AaiR2Bucket, AaiR2ListResult } from "./bindings.ts";

export type R2Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function extractXmlValues(xml: string, tag: string): string[] {
  const results: string[] = [];
  for (const match of xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))) {
    // biome-ignore lint/style/noNonNullAssertion: regex group 1 always present
    results.push(match[1]!);
  }
  return results;
}

export function createR2Binding(config: R2Config): AaiR2Bucket {
  const s3 = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: "auto",
    service: "s3",
  });

  function url(key: string): string {
    return `${config.endpoint}/${config.bucket}/${key}`;
  }

  return {
    async get(key, options) {
      const headers: Record<string, string> = {};
      if (options?.onlyIf?.etagDoesNotMatch) {
        headers["If-None-Match"] = options.onlyIf.etagDoesNotMatch;
      }
      const res = await s3.fetch(url(key), { headers });

      if (res.status === 304) return null;
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key}: ${res.status}`);

      const text = await res.text();
      const etag = res.headers.get("etag") ?? "";
      return {
        key,
        body: null,
        text: () => Promise.resolve(text),
        etag,
      };
    },

    async put(key, value, options) {
      const headers: Record<string, string> = {};
      if (options?.httpMetadata?.contentType) {
        headers["Content-Type"] = options.httpMetadata.contentType;
      }
      const body = typeof value === "string" ? value : value;
      const res = await s3.fetch(url(key), { method: "PUT", headers, body });
      if (!res.ok) throw new Error(`R2 PUT ${key}: ${res.status}`);

      const etag = res.headers.get("etag") ?? "";
      return {
        key,
        body: null,
        text: () => Promise.resolve(typeof value === "string" ? value : ""),
        etag,
      };
    },

    async delete(keys) {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      if (keyArr.length === 0) return;

      if (keyArr.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: checked length above
        const res = await s3.fetch(url(keyArr[0]!), { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          throw new Error(`R2 DELETE ${keyArr[0]}: ${res.status}`);
        }
        return;
      }

      const objects = keyArr.map((k) => `<Object><Key>${k}</Key></Object>`).join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete>${objects}</Delete>`;
      const deleteUrl = `${config.endpoint}/${config.bucket}?delete`;
      const res = await s3.fetch(deleteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });
      if (!res.ok) throw new Error(`R2 batch DELETE: ${res.status}`);
    },

    async list(options) {
      const params = new URLSearchParams({ "list-type": "2" });
      if (options?.prefix) params.set("prefix", options.prefix);
      if (options?.limit) params.set("max-keys", String(options.limit));

      const listUrl = `${config.endpoint}/${config.bucket}?${params}`;
      const res = await s3.fetch(listUrl);
      if (!res.ok) throw new Error(`R2 LIST: ${res.status}`);

      const xml = await res.text();
      const keys = extractXmlValues(xml, "Key");
      const etags = extractXmlValues(xml, "ETag");
      const isTruncated = xml.includes("<IsTruncated>true</IsTruncated>");

      const objects: AaiR2ListResult["objects"] = keys.map((k, i) => ({
        key: k,
        etag: etags[i] ?? "",
      }));

      return { objects, truncated: isTruncated };
    },
  };
}
