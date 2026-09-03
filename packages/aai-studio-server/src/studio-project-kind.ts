// Copyright 2026 the AAI authors. MIT license.
/**
 * What KIND of thing a studio project builds — the choice the new-project
 * screen's switcher makes, stamped on the workspace at create time.
 *
 * Two kinds, because the SDK has two front doors and they are not variations
 * of each other: `agent()` is a voice session (a microphone, a model loop,
 * spoken replies) and `workflowApp()` is a static page over durable workflow
 * runs (a form, a run id, no session at all). The fields are mutually
 * exclusive in the type system — `systemPrompt`, `tools` and every provider
 * field are compile errors on a workflow app — so the coding agent that gets
 * this wrong does not write a slightly-off agent, it writes one that cannot
 * build.
 *
 * It is a property of the PROJECT rather than of one request because the thing
 * that consumes it is the coding agent's system prompt, which is installed per
 * session (`studio/session-init`) and re-installed on every project open, page
 * reload and cross-replica adopt. A per-request flag would mean the second tab
 * builds under the other prompt.
 *
 * Dependency-free on purpose (the `studio-limits.ts` precedent): the zod schema
 * over these values lives in `studio-schemas.ts`, and both the workspace
 * document and the prompt composition import the type from here — so neither
 * has to reach for the HTTP layer to name it.
 *
 * The kind is a DEFAULT, not a cage. It decides which prompt the agent runs
 * under; that prompt still tells it to switch shapes when the user asks for
 * the other one outright, because "make it answer the phone instead" is a
 * legitimate turn and re-creating the project would throw away the work.
 */

/** Every project kind, in switcher order. */
export const PROJECT_KINDS = ["agent", "workflow"] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];

/**
 * What an unstamped project is. Every workspace written before the switcher
 * existed lacks the field, and a voice agent is what those projects were
 * built as — so absent must read as `agent` rather than as "unknown".
 */
export const DEFAULT_PROJECT_KIND: ProjectKind = "agent";

/**
 * The kind a stored value names, or the default for anything else.
 *
 * Takes `unknown` because the caller is reading a JSON document out of the
 * workspace store: `parseWorkspace` shape-checks `files` and casts the rest,
 * so a `kind` read from a row is a claim rather than a value. Narrowing here
 * is what keeps a hand-edited (or older, or newer) document from selecting no
 * prompt at all.
 */
export function resolveProjectKind(value: unknown): ProjectKind {
  return (PROJECT_KINDS as readonly string[]).includes(value as string)
    ? (value as ProjectKind)
    : DEFAULT_PROJECT_KIND;
}
