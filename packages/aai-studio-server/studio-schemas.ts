// Copyright 2025 the AAI authors. MIT license.
// Zod schemas + limits for the browser studio (coding agent) HTTP surface.

import { MAX_SLUG_LENGTH } from "@alexkroman1/aai/utils";
import slugifyLib from "@sindresorhus/slugify";
import { RESERVED_SLUGS, SafePathSchema, VALID_SLUG_RE } from "aai-server/schemas";
import { slugifyBase } from "aai-server/slug-generate";
import { z } from "zod";
import { MAX_STUDIO_FILE_BYTES, MAX_STUDIO_MESSAGE_BYTES } from "./studio-limits.ts";

// Re-exported from studio-limits.ts (the dependency-free limits home).
export {
  MAX_STUDIO_CHAT_MESSAGES,
  MAX_STUDIO_FILE_BYTES,
  MAX_STUDIO_FILES,
  MAX_STUDIO_MESSAGE_BYTES,
  MAX_STUDIO_WORKSPACE_BYTES,
} from "./studio-limits.ts";
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
 * the agent's URL, so it has to reduce to `VALID_SLUG_RE`. Built on the
 * platform's shared `slugifyBase` (see slug-generate.ts for the
 * transliteration/`decamelize` posture) so typed project names and
 * config-derived deploy-slug bases can't normalize differently.
 */
function slugifyProjectName(input: string): string {
  return slugifyBase(input, MAX_SLUG_LENGTH);
}

/** Upper bound on the prompt excerpt a generated name derives from. */
const MAX_NAME_PROMPT = 2000;

/** Longest prompt-derived readable base (the random suffix rides after it). */
const MAX_PROMPT_BASE = 30;

/**
 * Readable base for a server-generated project name, derived from the chat
 * prompt that created it — v0-style ("Build me a contact form agent" →
 * `contact-form`). The caller appends the random suffix
 * (`generatedSlug(base)` in aai-server), which is what guarantees
 * uniqueness; this only has to produce something recognizable. Filler words
 * are dropped so the name carries the prompt's subject, not its phrasing.
 * Empty in, empty out — the generator falls back to word-triple names.
 */
export function projectBaseFromPrompt(prompt: string): string {
  const words = slugifyLib(prompt.slice(0, MAX_NAME_PROMPT), { decamelize: false })
    .split("-")
    .filter((word) => word.length > 0 && !PROMPT_FILLER_WORDS.has(word));
  let base = "";
  for (const word of words.slice(0, 4)) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > MAX_PROMPT_BASE) break;
    base = next;
  }
  return base;
}

/** Leading filler in "build me a …" prompts — never the memorable part. */
const PROMPT_FILLER_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "i",
  "am",
  "is",
  "are",
  "me",
  "my",
  "we",
  "want",
  "need",
  "would",
  "like",
  "please",
  "can",
  "you",
  "to",
  "for",
  "of",
  "and",
  "that",
  "this",
  "with",
  "build",
  "make",
  "create",
  "write",
  "voice",
  "agent",
  "app",
  "bot",
]);

/**
 * Create a project. `name` is the legacy explicit path (slugified,
 * validated); when absent the server GENERATES the name — from `prompt`
 * when one is given (the guided chat-first flow), else from random words.
 * Name generation deliberately lives server-side so the studio and the CLI
 * deploy path (`POST /deploy` with no slug) share one generator.
 */
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
    .refine((name) => !RESERVED_SLUGS.has(name), "That name is reserved")
    .optional(),
  /** First chat message — seeds the generated name when `name` is absent. */
  prompt: z.string().max(MAX_NAME_PROMPT).optional(),
});

export const StudioFileSchema = z.object({
  path: SafePathSchema,
  content: z.string().max(MAX_STUDIO_FILE_BYTES),
});

/**
 * The one-time account onboarding body: the user's AssemblyAI API key,
 * stored server-side (`user-key:<uid>`) and resolved from their session on
 * every later request. Dots are rejected because a key never contains one —
 * a JWT pasted here by mistake would otherwise be stored as a "key" and fail
 * much later, deep in a provider call.
 */
export const AccountKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1, "API key is required")
    .max(512)
    .refine((key) => !key.includes("."), "That looks like a session token, not an API key"),
});

/**
 * A CLI link code: minted by `aai login` (32 random bytes, base64url),
 * approved by a signed-in browser session, exchanged ONCE by the CLI for
 * the account's stored API key. The grammar only has to admit what the CLI
 * mints; the length floor keeps a short, guessable code from ever being
 * approvable.
 */
export const CliLinkSchema = z.object({
  code: z.string().regex(/^[\w-]{32,128}$/, "Invalid link code"),
});

/**
 * Summed lengths of every string reachable inside `value` — the size that
 * matters in a chat message, counted without re-serializing it. The old
 * per-message `JSON.stringify(...).length` refine re-built megabytes of
 * string per request on a body that had *just* been parsed from a string;
 * this walk allocates nothing.
 * Structural overhead (keys, punctuation, numbers) is not
 * counted, so the cap is enforced on slightly less than serialized size —
 * string content is what dominates a near-limit message either way.
 */
function totalStringLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += totalStringLength(item);
    return total;
  }
  if (value !== null && typeof value === "object") {
    let total = 0;
    for (const item of Object.values(value)) total += totalStringLength(item);
    return total;
  }
  return 0;
}

/**
 * One `useChat` UIMessage. Validated structurally (role + parts) with a
 * content-size cap; the AI SDK's `convertToModelMessages` performs the
 * full part-level validation. The aggregate (whole-conversation) cap is
 * enforced in the guest's chat surface on the raw request body *before*
 * JSON parsing (`MAX_CHAT_BODY_BYTES` in `aai-guest/studio-chat.ts`) — so
 * it is deliberately absent here.
 */
export const UiMessageSchema = z
  .looseObject({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(z.looseObject({ type: z.string() })),
  })
  .refine(
    (message) => totalStringLength(message.parts) <= MAX_STUDIO_MESSAGE_BYTES,
    "Message too large",
  );
