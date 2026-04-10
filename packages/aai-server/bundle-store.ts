// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by unstorage (S3-compatible storage via Tigris, R2, etc.).

import { errorMessage } from "@alexkroman1/aai-core";
import { getLock } from "p-lock";
import type { Storage } from "unstorage";
import { z } from "zod";
import { IsolateConfigSchema } from "./rpc-schemas.ts";
import { AgentMetadataSchema } from "./schemas.ts";
import { type CredentialKey, decryptEnv, encryptEnv } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

export type { BundleStore } from "./store-types.ts";

const ManifestSchema = z.object({
  slug: z.string(),
  env: z.string(),
  credential_hashes: z.array(z.string()).optional(),
  envEncrypted: z.boolean().optional(),
});

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

export function createBundleStore(
  storage: Storage,
  opts: { credentialKey: CredentialKey },
): BundleStore {
  const { credentialKey } = opts;

  const manifestLock = getLock();

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
        await deleteByPrefix(`agents/${bundle.slug}`);
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

      await Promise.all([
        ...Object.entries(bundle.clientFiles).map(([filePath, content]) =>
          storage.setItem(objectKey(bundle.slug, `client/${filePath}`), content),
        ),
        storage.setItem(objectKey(bundle.slug, "config.json"), JSON.stringify(bundle.agentConfig)),
      ]);
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
      await deleteByPrefix(`agents/${slug}`);
    },

    async getEnv(slug) {
      const raw = await getRawManifest(slug);
      if (!raw) return null;
      return await decryptEnv(credentialKey, { encrypted: raw.env, slug });
    },

    async putEnv(slug, env) {
      const release = await manifestLock(slug);
      try {
        const raw = await getRawManifest(slug);
        if (!raw) throw new Error(`Agent ${slug} not found`);
        const updated = {
          ...raw,
          env: await encryptEnv(credentialKey, { env, slug }),
          envEncrypted: true,
        };
        await storage.setItem(objectKey(slug, "manifest.json"), JSON.stringify(updated));
      } finally {
        release();
      }
    },

    async getAgentConfig(slug) {
      const data = await storage.getItem<string>(objectKey(slug, "config.json"));
      if (data == null) return null;
      try {
        const raw = typeof data === "string" ? data : JSON.stringify(data);
        return IsolateConfigSchema.parse(JSON.parse(raw));
      } catch {
        return null;
      }
    },
  };

  return store;
}
