// Copyright 2025 the AAI authors. MIT license.
// Zod schemas -- validate untrusted input at HTTP/WebSocket boundaries.

import { posix } from "node:path";
import { RESERVED_SLUGS, VALID_SLUG_RE } from "@alexkroman1/aai/internal";
import { z } from "zod";
import { MAX_WORKER_SIZE } from "./constants.ts";

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

// The slug contract (shape + reserved names) lives in the shared SDK so the
// CLI validates against the exact rules this server enforces.
export { RESERVED_SLUGS, VALID_SLUG_RE } from "@alexkroman1/aai/internal";

/**
 * `VALID_SLUG_RE`'s source with its `^…$` anchors stripped, for embedding
 * inside larger patterns (the bare-slug Hono route param, the WS upgrade
 * path matcher). The one place that depends on the regex literally starting
 * with `^` and ending with `$` — consumers compose from this instead of
 * re-deriving the slice.
 */
export const SLUG_PATTERN_SOURCE = VALID_SLUG_RE.source.slice(1, -1);

export const DeployBodySchema = z.object({
  slug: z
    .string()
    .regex(VALID_SLUG_RE, "Invalid slug format")
    .refine((s) => !RESERVED_SLUGS.has(s), "Reserved slug")
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Opt in to a `-preview`-suffixed slug (`aai deploy --allow-preview-slug`).
  // That suffix is owned by the studio's auto-preview deploys and reaped by
  // the orphan-preview sweep; deployAgentBundle rejects it otherwise, so a CLI
  // caller can't lose an agent to the reaper by accident. Set only by the
  // studio's in-guest deploy.
  allowPreviewSlug: z.boolean().optional(),
  worker: z.string().min(1).max(MAX_WORKER_SIZE),
  clientFiles: z
    .record(SafePathSchema, z.string().max(MAX_WORKER_SIZE))
    .refine((files) => Object.keys(files).length <= 100, "Too many client files (max 100)"),
  // No agentConfig field, no name, and no server-side extraction behind
  // either: the platform stores artifacts and ownership, never a description
  // of what the bundle IS — a generated slug is human-id words plus a random
  // suffix. See "The platform stores no agent config" in CLAUDE.md.
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

export const EnvSchema = z.record(z.string(), z.string());

// Secrets
export const SecretKeySchema = z.string().regex(/^[a-zA-Z_]\w*$/, "Invalid secret key name");
export const SecretUpdatesSchema = z.record(SecretKeySchema, z.string());
