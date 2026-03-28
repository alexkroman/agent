// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by unstorage (S3-compatible storage via Tigris, R2, etc.).

import { errorMessage } from "@alexkroman1/aai/utils";
import AsyncLock from "async-lock";
import type { Storage } from "unstorage";
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

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

export function createBundleStore(
  storage: Storage,
  opts: { credentialKey: CredentialKey },
): BundleStore {
  const { credentialKey } = opts;

  const manifestLock = new AsyncLock();

  async function deleteByPrefix(prefix: string): Promise<void> {
    const keys = await storage.getKeys(prefix);
    await Promise.all(keys.map((k) => storage.removeItem(k)));
  }

  async function getRawManifest(slug: string): Promise<z.infer<typeof ManifestSchema> | null> {
    const data = await storage.getItem<string>(objectKey(slug, "manifest.json"));
    if (data == null) return null;
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    return ManifestSchema.parse(JSON.parse(raw));
  }

  const store: BundleStore = {
    async putAgent(bundle) {
      try {
        await deleteByPrefix(`agents:${bundle.slug}`);
      } catch (err) {
        console.warn(
          `Failed to delete old agent files for ${bundle.slug}, proceeding with overwrite: ${errorMessage(err)}`,
        );
      }

      const manifest = {
        slug: bundle.slug,
        env: await encryptEnv(credentialKey, { env: bundle.env, slug: bundle.slug }),
        credential_hashes: bundle.credential_hashes,
        envEncrypted: true,
      };
      await storage.setItem(objectKey(bundle.slug, "manifest.json"), JSON.stringify(manifest));
      await storage.setItem(objectKey(bundle.slug, "worker.js"), bundle.worker);

      await Promise.all(
        Object.entries(bundle.clientFiles).map(([filePath, content]) =>
          storage.setItem(objectKey(bundle.slug, `client/${filePath}`), content),
        ),
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
      return (await storage.getItem<string>(objectKey(slug, "worker.js"))) ?? null;
    },

    async getClientFile(slug, filePath) {
      return (await storage.getItem<string>(objectKey(slug, `client/${filePath}`))) ?? null;
    },

    async deleteAgent(slug) {
      await deleteByPrefix(`agents:${slug}`);
    },

    async getEnv(slug) {
      const raw = await getRawManifest(slug);
      if (!raw) return null;
      return await decryptEnv(credentialKey, { encrypted: raw.env, slug });
    },

    async putEnv(slug, env) {
      await manifestLock.acquire(slug, async () => {
        const raw = await getRawManifest(slug);
        if (!raw) throw new Error(`Agent ${slug} not found`);
        const updated = {
          ...raw,
          env: await encryptEnv(credentialKey, { env, slug }),
          envEncrypted: true,
        };
        await storage.setItem(objectKey(slug, "manifest.json"), JSON.stringify(updated));
      });
    },
  };

  return store;
}
