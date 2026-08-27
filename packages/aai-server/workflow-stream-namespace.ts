// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-tenant stream names — the fix for a lookup that has no run key.
 *
 * `readFromStream(name, startIndex?)` takes no run id, and
 * `@workflow/world-postgres` implements it as `where(eq(streams.streamId, name))`
 * with no run filter; its live fan-out keys on `strm:${name}` the same way. With
 * every agent's streams in one schema, two agents that pick the same stream name
 * read each other's chunks — and NO amount of checking at the HTTP layer closes
 * that, because their query genuinely cannot tell the two streams apart.
 *
 * So the name is qualified on the way in and unqualified on the way out. Their
 * global-by-name lookup can then only reach this agent's stream, BY CONSTRUCTION
 * rather than by a check somebody has to remember to write — which is the same
 * reason `workflow-run-owner.ts` checks ownership on the way in rather than
 * filtering on the way out.
 *
 * ## Why the slug, and not a hash of it
 *
 * A slug is already a safe identifier and it makes a row in
 * `workflow.workflow_stream_chunks` readable to whoever is debugging one. A hash
 * would cost that for no gain: the value is not a secret — a tenant already knows
 * its own slug — and there is no length pressure, because the name is a `text`
 * column and a JSON payload field, never a Postgres channel name. Their NOTIFY
 * topic is a constant, so the 63-byte identifier limit never applies.
 *
 * ## The separator cannot appear in a slug
 *
 * `/` is not in the slug grammar (`SLUG_PATTERN_SOURCE`), so the FIRST one is
 * always the boundary — while a stream NAME may contain anything, including a
 * `/`. Splitting on the first occurrence and requiring the prefix to be this
 * agent's slug is what makes the round trip exact.
 */

/** What separates the tenant from the name. Not a legal slug character. */
const SEPARATOR = "/";

/**
 * This agent's name for a stream.
 *
 * @internal
 */
export function qualifyStreamName(slug: string, name: string): string {
  return `${slug}${SEPARATOR}${name}`;
}

/**
 * The agent's own name back, or undefined when the qualified name is not theirs.
 *
 * Undefined rather than the raw value: a name that does not carry this agent's
 * prefix is a name from somewhere else, and returning it would hand back a value
 * this code cannot attribute. The caller drops it.
 *
 * @internal
 */
export function unqualifyStreamName(slug: string, qualified: string): string | undefined {
  const prefix = `${slug}${SEPARATOR}`;
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : undefined;
}
