// Copyright 2025 the AAI authors. MIT license.
// Zod schemas -- validate untrusted input at HTTP/WebSocket boundaries.

import { posix } from "node:path";
import { type KvRequest, KvRequestSchema } from "@alexkroman1/aai/protocol";
import { z } from "zod";

/**
 * Zod schema for a safe relative file path.
 * Normalizes with `path.posix.normalize` and rejects traversal (`..`),
 * absolute paths, backslashes, and null bytes.
 */
export const SafePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\0"), "Path must not contain null bytes")
  .refine((p) => !p.includes("\\"), "Path must not contain backslashes")
  .transform((p) => posix.normalize(p))
  .refine((p) => !p.startsWith("/"), "Path must be relative")
  .refine((p) => !p.startsWith(".."), "Path must not traverse above root");

export const DeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(10_000_000),
  clientFiles: z.record(SafePathSchema, z.string()),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

export const EnvSchema = z
  .object({
    ASSEMBLYAI_API_KEY: z.string().min(1),
  })
  .catchall(z.string());

export type AgentMetadata = {
  slug: string;
  env: Record<string, string>;
  credential_hashes: string[];
};

export const AgentMetadataSchema: z.ZodType<AgentMetadata> = z.object({
  slug: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  credential_hashes: z.array(z.string()).default([]),
});

// KV
export type KvHttpRequest = KvRequest;
export const KvHttpRequestSchema: z.ZodType<KvHttpRequest> = KvRequestSchema;

// Vector
export const VectorRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    id: z.string().min(1),
    data: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    op: z.literal("query"),
    text: z.string().min(1),
    topK: z.number().int().positive().max(100).optional(),
    filter: z.string().optional(),
  }),
  z.object({
    op: z.literal("remove"),
    ids: z.array(z.string().min(1)).min(1),
  }),
]);

export type VectorHttpRequest = z.infer<typeof VectorRequestSchema>;

// Secrets
export const SecretUpdatesSchema = z.record(z.string(), z.string());
