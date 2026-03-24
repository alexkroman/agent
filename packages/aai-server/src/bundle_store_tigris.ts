// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by S3-compatible storage (Tigris) via aws4fetch.

import { AwsClient } from "aws4fetch";
import type { AgentMetadata } from "./_schemas.ts";
import { AgentMetadataSchema } from "./_schemas.ts";
import { type CredentialKey, decryptEnv, encryptEnv } from "./credentials.ts";

const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  map: "application/json",
};

function mimeForExt(ext: string): string {
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export type DeployStore = {
  putAgent(bundle: {
    slug: string;
    env: Record<string, string>;
    worker: string;
    clientFiles: Record<string, string>;
    credential_hashes: string[];
  }): Promise<void>;
  getManifest(slug: string): Promise<AgentMetadata | null>;
  getWorkerCode(slug: string): Promise<string | null>;
  deleteAgent(slug: string): Promise<void>;
  getEnv(slug: string): Promise<Record<string, string> | null>;
  putEnv(slug: string, env: Record<string, string>): Promise<void>;
};

export type AssetStore = {
  getClientFile(slug: string, filePath: string): Promise<string | null>;
};

export type BundleStore = DeployStore & AssetStore;

type CacheEntry = {
  data: string;
  etag: string;
};

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

export type S3Client = AwsClient & { endpoint: string };

export function createS3Client(env: {
  AWS_ENDPOINT_URL_S3?: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}): S3Client {
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });
  return Object.assign(client, {
    endpoint: env.AWS_ENDPOINT_URL_S3 ?? "https://s3.amazonaws.com",
  });
}

function s3Url(s3: S3Client, bucket: string, key: string): string {
  return `${s3.endpoint}/${bucket}/${key}`;
}

// Simple XML helpers for S3 responses

function extractXmlValues(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, "g");
  for (const match of xml.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: regex group 1 always present
    results.push(match[1]!);
  }
  return results;
}

function buildDeleteXml(keys: string[]): string {
  const objects = keys.map((k) => `<Object><Key>${k}</Key></Object>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Delete>${objects}</Delete>`;
}

export function createBundleStore(
  s3: S3Client,
  opts: { bucket: string; credentialKey: CredentialKey },
): BundleStore {
  const { bucket, credentialKey } = opts;
  const cache = new Map<string, CacheEntry>();

  async function put(key: string, body: string, contentType: string): Promise<void> {
    const url = s3Url(s3, bucket, key);
    const res = await s3.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${text}`);
    }
    const etag = res.headers.get("etag");
    if (etag) {
      cache.set(key, { data: body, etag });
    }
  }

  async function get(key: string): Promise<string | null> {
    const url = s3Url(s3, bucket, key);
    const cached = cache.get(key);
    const headers: Record<string, string> = {};
    if (cached) headers["If-None-Match"] = cached.etag;

    const res = await s3.fetch(url, { headers });

    if (res.status === 304 && cached) {
      return cached.data;
    }
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`S3 GET ${key} failed: ${res.status} ${text}`);
    }

    const data = await res.text();
    const etag = res.headers.get("etag");
    if (etag) {
      cache.set(key, { data, etag });
    }
    return data;
  }

  async function deleteAgent(slug: string): Promise<void> {
    const prefix = `agents/${slug}/`;
    const listUrl = `${s3.endpoint}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listRes = await s3.fetch(listUrl);
    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`S3 LIST failed: ${listRes.status} ${text}`);
    }

    const xml = await listRes.text();
    const keys = extractXmlValues(xml, "Key");
    if (keys.length === 0) return;

    const deleteUrl = `${s3.endpoint}/${bucket}?delete`;
    const deleteRes = await s3.fetch(deleteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildDeleteXml(keys),
    });
    if (!deleteRes.ok) {
      const text = await deleteRes.text();
      throw new Error(`S3 DELETE failed: ${deleteRes.status} ${text}`);
    }

    for (const k of keys) cache.delete(k);
  }

  async function getRawManifest(slug: string): Promise<Record<string, unknown> | null> {
    const data = await get(objectKey(slug, "manifest.json"));
    if (data === null) return null;
    return JSON.parse(data);
  }

  const store: BundleStore = {
    async putAgent(bundle) {
      try {
        await deleteAgent(bundle.slug);
      } catch (err) {
        console.warn(
          `Failed to delete old agent files for ${bundle.slug}, proceeding with overwrite: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const manifest = {
        slug: bundle.slug,
        env: await encryptEnv(credentialKey, { env: bundle.env, slug: bundle.slug }),
        credential_hashes: bundle.credential_hashes,
        envEncrypted: true,
      };
      await put(
        objectKey(bundle.slug, "manifest.json"),
        JSON.stringify(manifest),
        "application/json",
      );
      await put(objectKey(bundle.slug, "worker.js"), bundle.worker, "application/javascript");

      await Promise.all(
        Object.entries(bundle.clientFiles).map(([filePath, content]) => {
          const ext = filePath.split(".").pop() ?? "";
          return put(objectKey(bundle.slug, `client/${filePath}`), content, mimeForExt(ext));
        }),
      );
    },

    async getManifest(slug) {
      const raw = await getRawManifest(slug);
      if (!raw) return null;
      raw.env = await decryptEnv(credentialKey, { encrypted: raw.env as string, slug });
      delete raw.envEncrypted;
      const parsed = AgentMetadataSchema.safeParse(raw);
      if (!parsed.success) return null;
      return parsed.data;
    },

    async getWorkerCode(slug) {
      return await get(objectKey(slug, "worker.js"));
    },

    async getClientFile(slug, filePath) {
      return await get(objectKey(slug, `client/${filePath}`));
    },

    deleteAgent,

    async getEnv(slug) {
      const raw = await getRawManifest(slug);
      if (!raw) return null;
      return await decryptEnv(credentialKey, { encrypted: raw.env as string, slug });
    },

    async putEnv(slug, env) {
      const raw = await getRawManifest(slug);
      if (!raw) throw new Error(`Agent ${slug} not found`);
      raw.env = await encryptEnv(credentialKey, { env, slug });
      raw.envEncrypted = true;
      await put(objectKey(slug, "manifest.json"), JSON.stringify(raw), "application/json");
    },
  };

  return store;
}
