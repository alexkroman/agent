// Copyright 2025 the AAI authors. MIT license.
// Zod schemas -- validate untrusted input at HTTP/WebSocket boundaries.

import { posix } from "node:path";
import { z } from "zod";
import { MAX_WORKER_SIZE } from "./constants.ts";
import { IsolateConfigSchema } from "./rpc-schemas.ts";

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

export const VALID_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

export const DeployBodySchema = z.object({
  slug: z.string().regex(VALID_SLUG_RE, "Invalid slug format").optional(),
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(MAX_WORKER_SIZE),
  clientFiles: z
    .record(SafePathSchema, z.string().max(MAX_WORKER_SIZE))
    .refine((files) => Object.keys(files).length <= 100, "Too many client files (max 100)"),
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfigSchema,
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

export const EnvSchema = z.record(z.string(), z.string());

export const AgentMetadataSchema = z.object({
  slug: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  credential_hashes: z.array(z.string()).default([]),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

// Secrets
const SecretKeySchema = z.string().regex(/^[a-zA-Z_]\w*$/, "Invalid secret key name");
export const SecretUpdatesSchema = z.record(SecretKeySchema, z.string());
