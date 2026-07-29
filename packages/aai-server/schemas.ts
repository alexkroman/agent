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

/**
 * Safe KV key: non-empty, no path traversal. The agent prefix
 * (`agents/${slug}/kv`) uses `/` as the namespace separator, so `/`, `\`,
 * `..`, and null bytes are rejected. `:` is allowed — a common Redis-style
 * delimiter for hierarchical keys (e.g. `incident:INC-0001`).
 *
 * This is the single key grammar for BOTH boundaries that accept KV keys:
 * the owner HTTP routes (`GET`/`POST /:slug/kv`) and the guest→host RPC
 * (sandbox-guest-rpc.ts, which currently restates the same rules — keep the
 * two in lockstep so a key written on one side is always reachable from the
 * other).
 */
export const SafeKvKeySchema = z
  .string()
  .min(1)
  .refine((k) => !k.includes("\0"), "Key must not contain null bytes")
  .refine((k) => !k.includes("/"), "Key must not contain /")
  .refine((k) => !k.includes("\\"), "Key must not contain \\")
  .refine((k) => !k.includes(".."), "Key must not contain ..");

export const VALID_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

/**
 * Slugs that collide with top-level platform routes and can never be claimed
 * by an agent. `/studio` is the browser coding-agent UI's API namespace;
 * `/studio-assets` serves its client build; `/health` and `/metrics` are the
 * platform health check and Prometheus endpoint; `POST /deploy` is the
 * top-level deploy route (an agent named `deploy` could never be deployed to
 * by slug, and its page would shadow the redirect).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "studio",
  "studio-assets",
  "health",
  "metrics",
  "deploy",
]);

export const DeployBodySchema = z.object({
  slug: z
    .string()
    .regex(VALID_SLUG_RE, "Invalid slug format")
    .refine((s) => !RESERVED_SLUGS.has(s), "Reserved slug")
    .optional(),
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
export const SecretKeySchema = z.string().regex(/^[a-zA-Z_]\w*$/, "Invalid secret key name");
export const SecretUpdatesSchema = z.record(SecretKeySchema, z.string());
