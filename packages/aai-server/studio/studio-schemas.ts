// Copyright 2025 the AAI authors. MIT license.
// Zod schemas + limits for the browser studio (coding agent) HTTP surface.

import { z } from "zod";
import { RESERVED_SLUGS, SafePathSchema, VALID_SLUG_RE } from "../schemas.ts";

/** Max files per studio project workspace. */
export const MAX_STUDIO_FILES = 30;
/** Max bytes for a single workspace file. */
export const MAX_STUDIO_FILE_BYTES = 256_000;
/** Max total bytes across a workspace (guards the single-doc storage model). */
export const MAX_STUDIO_WORKSPACE_BYTES = 1_000_000;
/** Max messages accepted per chat turn (client resends full history). */
export const MAX_STUDIO_CHAT_MESSAGES = 80;
/**
 * Max serialized bytes for a single chat message. Sized so an assistant
 * message carrying a couple of full-file tool outputs still fits.
 */
export const MAX_STUDIO_MESSAGE_BYTES = 600_000;
/** Max serialized bytes for the whole resent history. */
export const MAX_STUDIO_CHAT_BYTES = 4_000_000;

/**
 * Project names share the slug grammar so they can double as deploy slugs.
 * This is the *identifier* form — used for path params and chat bodies, where
 * the name is addressing an existing project. Creation is lenient; see
 * `CreateProjectSchema`.
 */
export const ProjectNameSchema = z.string().regex(VALID_SLUG_RE, "Invalid project name");

/** Upper bound on a typed name, before slugification. */
const MAX_TYPED_PROJECT_NAME = 100;

/**
 * Normalize a human-typed project name into the slug grammar.
 *
 * People type "My Agent"; the name doubles as the deploy slug and appears in
 * the agent's URL, so it has to reduce to `VALID_SLUG_RE`. Non-alphanumerics
 * collapse to single dashes and the edges are trimmed — the same shape GitHub
 * and Vercel produce, so the result is predictable rather than surprising.
 *
 * Note this is deliberately ASCII-only: "Café" becomes "caf". Transliterating
 * accents would need a mapping table for every script, and the slug is an
 * identifier, not a display name.
 */
export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)
    .replace(/[-_]+$/g, "");
}

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_TYPED_PROJECT_NAME)
    .transform(slugifyProjectName)
    .refine(
      (name) => VALID_SLUG_RE.test(name),
      "Project name must contain at least two letters or numbers",
    )
    // Caught here rather than at publish: a project that can never go live is
    // a dead end the user only discovers after building in it.
    .refine((name) => !RESERVED_SLUGS.has(name), "That name is reserved"),
});

export const StudioFileSchema = z.object({
  path: SafePathSchema,
  content: z.string().max(MAX_STUDIO_FILE_BYTES),
});

/**
 * One `useChat` UIMessage. Validated structurally (role + parts) with a
 * serialized-size cap; the AI SDK's `convertToModelMessages` performs the
 * full part-level validation.
 */
export const UiMessageSchema = z
  .looseObject({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(z.looseObject({ type: z.string() })),
  })
  .refine(
    (message) => JSON.stringify(message).length <= MAX_STUDIO_MESSAGE_BYTES,
    "Message too large",
  );

export const ChatBodySchema = z.object({
  project: ProjectNameSchema,
  messages: z
    .array(UiMessageSchema)
    .min(1)
    .max(MAX_STUDIO_CHAT_MESSAGES)
    .refine(
      (messages) => JSON.stringify(messages).length <= MAX_STUDIO_CHAT_BYTES,
      "Conversation too large",
    ),
});

export type ChatBody = z.infer<typeof ChatBodySchema>;

/** Env/secrets to merge into the agent's stored env at deploy time. */
export const StudioDeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
});

export type StudioDeployBody = z.infer<typeof StudioDeployBodySchema>;
