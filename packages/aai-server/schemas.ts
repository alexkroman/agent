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

/** Max number of client files accepted in a single deploy. */
export const MAX_CLIENT_FILES = 100;

export const EnvSchema = z.record(z.string(), z.string());

export const DeployBodySchema = z.object({
  slug: z.string().regex(VALID_SLUG_RE, "Invalid slug format").optional(),
  env: EnvSchema.optional(),
  worker: z.string().min(1).max(MAX_WORKER_SIZE),
  clientFiles: z
    .record(SafePathSchema, z.string().max(MAX_WORKER_SIZE))
    .refine(
      (files) => Object.keys(files).length <= MAX_CLIENT_FILES,
      `Too many client files (max ${MAX_CLIENT_FILES})`,
    ),
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfigSchema,
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

export const AgentMetadataSchema = z.object({
  slug: z.string(),
  env: EnvSchema.default({}),
  credential_hashes: z.array(z.string()).default([]),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

// Secrets
export const SecretKeySchema = z.string().regex(/^[a-zA-Z_]\w*$/, "Invalid secret key name");
export const SecretUpdatesSchema = z.record(SecretKeySchema, z.string());
