// Copyright 2025 the AAI authors. MIT license.
// Zod schemas + limits for the browser studio (coding agent) HTTP surface.

import { MAX_SLUG_LENGTH } from "@alexkroman1/aai/internal";
import { slugifyName } from "@alexkroman1/aai/slugify";
import { isRecord } from "@alexkroman1/aai/utils";
import { generatedSlug, RESERVED_SLUGS, SafePathSchema, VALID_SLUG_RE } from "aai-server/config";
import { z } from "zod";
import { GITHUB_NAME_RE } from "./studio-github-sync.ts";
import { MAX_STUDIO_FILE_BYTES, MAX_STUDIO_MESSAGE_BYTES } from "./studio-limits.ts";
import { DEFAULT_PROJECT_KIND, PROJECT_KINDS } from "./studio-project-kind.ts";

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
 * platform's shared `slugifyName` (`@alexkroman1/aai/slugify` — see it for
 * the transliteration/`decamelize` posture) so a typed project name, a
 * prompt-derived base, and a CLI directory name can't normalize differently.
 */
function slugifyProjectName(input: string): string {
  return slugifyName(input, MAX_SLUG_LENGTH);
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
  const words = slugifyName(prompt.slice(0, MAX_NAME_PROMPT), MAX_NAME_PROMPT)
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

/**
 * A whole server-generated project name: the readable prompt-derived base
 * above plus the random suffix that makes it unique (`contact-form-x7k2mq`).
 *
 * Beside the base it is built from rather than in the route, which is where it
 * used to live: this module owns every rule about what a project may be called
 * — the identifier grammar, the slugification of a typed name, the filler
 * words — and a name minted somewhere else is how a fourth spelling appears.
 */
export function generateProjectName(prompt: string | undefined): string {
  return generatedSlug(prompt ? projectBaseFromPrompt(prompt) : undefined);
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
 * What the project builds, as the create body carries it — the new-project
 * screen's Agent/Workflow switcher.
 *
 * Defaulted rather than optional, so the route always holds a kind and the
 * workspace is always stamped with one: an explicit `"agent"` on a new
 * document says "this project chose voice", where absence would be
 * indistinguishable from a document written before the switcher existed.
 * Callers that predate it (the CLI's first push, evals, tests) get the same
 * default they would have got from `resolveProjectKind`.
 */
export const ProjectKindSchema = z.enum(PROJECT_KINDS).default(DEFAULT_PROJECT_KIND);

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
  /** Voice agent or workflow app — decides the coding agent's system prompt. */
  kind: ProjectKindSchema,
});

export const StudioFileSchema = z.object({
  path: SafePathSchema,
  content: z.string().max(MAX_STUDIO_FILE_BYTES),
});

/**
 * `PUT /projects/:project/source` — the CLI `aai push` body: the complete
 * replacement file map, plus the optional fast-forward token (the
 * `sourceHash` the caller pulled — see `syncWorkspaceSource` for why the
 * token is the files hash, not the row version). Per-file paths and the
 * count/total-size caps are enforced by the workspace write itself
 * (`stampWorkspace`), the one place every writer — editor PUT, guest sync,
 * this route — goes through.
 */
export const SyncSourceSchema = z.object({
  files: z.record(z.string(), z.string().max(MAX_STUDIO_FILE_BYTES)),
  baseHash: z.string().max(128).optional(),
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
/** What a value contains, for the walk below: members, values, or nothing. */
function childValues(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? Object.values(value) : [];
}

function totalStringLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  // ONE summing loop: the array and record branches summed their members
  // identically, which is a copy of a loop rather than a second case.
  let total = 0;
  for (const item of childValues(value)) total += totalStringLength(item);
  return total;
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

/**
 * A `owner/repo` as a sync body carries it.
 *
 * Both halves become PATH SEGMENTS in every GitHub request the sync makes, so
 * the grammar is enforced before the value is ever interpolated — built from
 * `GITHUB_NAME_RE` (studio-github-sync.ts) rather than restated, so the two
 * layers that check it cannot drift apart.
 */
const NAME = GITHUB_NAME_RE.source.slice(1, -1);
export const GithubRepoSchema = z
  .string()
  .min(3)
  .max(201)
  .regex(new RegExp(`^${NAME}/${NAME}$`), "Expected owner/repo");

/**
 * `POST /studio/projects/:project/github/sync` — where to push.
 *
 * The BRANCH is deliberately not a field. A sync always targets the
 * repository's own default branch, read from GitHub at push time
 * (`readRepoDefaultBranch`) rather than taken from the client: the picker's
 * copy can be a rename out of date, and a branch name accepted from a request
 * would be a validated-but-unreachable input surface — the studio has no UI
 * that names one. Re-adding it means adding the control and the grammar
 * together, not the grammar alone.
 */
export const GithubSyncSchema = z.object({
  repo: GithubRepoSchema,
});

/**
 * `POST /studio/github/connect` — mint an install redirect.
 *
 * `project` is a RETURN hint so the callback lands the user back where they
 * pressed the button; it authorizes nothing, and is validated as a project
 * name only so the callback can build a URL from it without escaping games.
 */
export const GithubConnectSchema = z.object({
  project: ProjectNameSchema.optional(),
});

/**
 * `POST /studio/github/repos` — create a repository under the installation's
 * organization. The name runs the slug grammar rather than GitHub's laxer
 * one so a repository this creates is always nameable by every other surface.
 */
export const GithubCreateRepoSchema = z.object({
  name: z.string().min(1).max(100).regex(VALID_SLUG_RE, "Invalid repository name"),
});
