// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by S3-compatible storage (Tigris) via @aws-sdk/client-s3.

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import type { AgentMetadata } from "./_schemas.ts";
import { AgentMetadataSchema } from "./_schemas.ts";
import { type CredentialKey, decryptEnv, encryptEnv } from "./credentials.ts";

const ManifestSchema = z.object({
  slug: z.string(),
  env: z.string(),
  credential_hashes: z.array(z.string()).optional(),
  envEncrypted: z.boolean().optional(),
});

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

export type BundleStore = {
  putAgent(bundle: {
    slug: string;
    env: Record<string, string>;
    worker: string;
    clientFiles: Record<string, string>;
    credential_hashes: string[];
  }): Promise<void>;
  getManifest(slug: string): Promise<AgentMetadata | null>;
  getWorkerCode(slug: string): Promise<string | null>;
  getClientFile(slug: string, filePath: string): Promise<string | null>;
  deleteAgent(slug: string): Promise<void>;
  getEnv(slug: string): Promise<Record<string, string> | null>;
  putEnv(slug: string, env: Record<string, string>): Promise<void>;
};

type CacheEntry = {
  data: string;
  etag: string;
};

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

export function createS3Client(env: {
  AWS_ENDPOINT_URL_S3?: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}): S3Client {
  return new S3Client({
    region: "auto",
    ...(env.AWS_ENDPOINT_URL_S3 != null && { endpoint: env.AWS_ENDPOINT_URL_S3 }),
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

export function createBundleStore(
  s3: S3Client,
  opts: { bucket: string; credentialKey: CredentialKey },
): BundleStore {
  const { bucket, credentialKey } = opts;
  const cache = new Map<string, CacheEntry>();

  // Per-slug mutex to serialize read-modify-write operations on the manifest.
  const manifestLocks = new Map<string, Promise<void>>();
  async function withManifestLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = manifestLocks.get(slug) ?? Promise.resolve();
    const { promise: next, resolve } = Promise.withResolvers<void>();
    manifestLocks.set(slug, next);
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
    }
  }

  async function put(key: string, body: string, contentType: string): Promise<void> {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    const etag = res.ETag;
    if (etag) {
      cache.set(key, { data: body, etag });
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: S3 conditional GET with cache + error handling
  async function get(key: string): Promise<string | null> {
    const cached = cache.get(key);
    try {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(cached ? { IfNoneMatch: cached.etag } : {}),
        }),
      );
      const data = (await res.Body?.transformToString()) ?? "";
      const etag = res.ETag;
      if (etag) {
        cache.set(key, { data, etag });
      }
      return data;
    } catch (err: unknown) {
      const code = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code === "NoSuchKey" || code === "NotFound") return null;
      // AWS SDK v3 throws Unknown with status 304 for conditional GET responses
      if (status === 304 || code === "NotModified") return cached?.data ?? null;
      throw err;
    }
  }

  async function deleteAgent(slug: string): Promise<void> {
    const prefix = `agents/${slug}/`;
    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));

    const keys = (listRes.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((k): k is string => typeof k === "string");
    if (keys.length === 0) return;

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );

    for (const k of keys) cache.delete(k);
  }

  async function getRawManifest(slug: string): Promise<z.infer<typeof ManifestSchema> | null> {
    const data = await get(objectKey(slug, "manifest.json"));
    if (data === null) return null;
    return ManifestSchema.parse(JSON.parse(data));
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
      const env = await decryptEnv(credentialKey, { encrypted: raw.env, slug });
      const parsed = AgentMetadataSchema.safeParse({
        ...raw,
        env,
        envEncrypted: undefined,
      });
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
      return await decryptEnv(credentialKey, { encrypted: raw.env, slug });
    },

    async putEnv(slug, env) {
      await withManifestLock(slug, async () => {
        const raw = await getRawManifest(slug);
        if (!raw) throw new Error(`Agent ${slug} not found`);
        const updated = {
          ...raw,
          env: await encryptEnv(credentialKey, { env, slug }),
          envEncrypted: true,
        };
        await put(objectKey(slug, "manifest.json"), JSON.stringify(updated), "application/json");
      });
    },
  };

  return store;
}
