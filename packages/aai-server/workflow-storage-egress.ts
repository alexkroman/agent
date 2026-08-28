// Copyright 2026 the AAI authors. MIT license.
/**
 * Nothing foreign leaves: the outbound half of the run-storage tenant boundary.
 *
 * `workflow-storage-scope.ts` decides how a call is scoped and
 * `workflow-storage-apply.ts` enforces it. Both answer "was this CALL allowed".
 * This answers the different question — "is what I am about to send back
 * actually theirs" — against the REPLY, so it holds without knowing which scope
 * ran. Its own module because it shares nothing with the scopes but the
 * ownership table, and because `apply.ts` is at its length cap.
 *
 * Read {@link assertEveryRunIsOurs} for what it does and does not cover; the
 * short version is that it catches a scope that RETURNS something foreign and
 * cannot catch one that wrongly established ownership on the way in.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "./logger.ts";

/** The reserved connection's query, as `ServeContext` supplies it. */
type Sql = (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;

const log = createLogger("workflow.storage");

/**
 * A run id as both generators write it.
 *
 * `@workflow/core`'s `start.js` mints `wrun_${ulid()}` client-side and
 * `world-postgres`'s `storage.js` does the same when no id is supplied, so this
 * is the whole grammar — `wrun_` plus 26 characters of Crockford base32 (no I, L,
 * O or U).
 */
const RUN_ID_RE = /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Keys whose value names a run whatever the id format is. */
const RUN_ID_KEYS: ReadonlySet<string> = new Set(["runId", "workflowRunId"]);

/**
 * How deep the reply walk goes before giving up.
 *
 * A tenant's own run output is in here and is arbitrary JSON, so the walk needs a
 * bound. Well past anything the DevKit nests (`{ run, event }` with an `input`
 * object inside is three) and far short of a stack problem.
 */
const WALK_MAX_DEPTH = 12;

/**
 * Every run id the reply mentions.
 *
 * TWO signals, unioned, and the redundancy is the point — a check that silently
 * stops finding anything is the failure mode this whole file exists to prevent,
 * so neither signal alone is trusted:
 *
 * - a string under a key that NAMES a run (`runId`, `workflowRunId`), which
 *   survives the id format changing;
 * - a string matching {@link RUN_ID_RE} anywhere, which survives the KEY
 *   changing — and is what catches a run entity's own `id`, since the DevKit
 *   spreads its row and the primary key column is just `id`. Matching on the
 *   grammar rather than on that key name is deliberate: a step, event and hook
 *   all have an `id` too, and checking those against the ownership table would
 *   500 on every legitimate read.
 *
 * A tenant that stores a well-formed FOREIGN run id inside its own run output
 * fails this check. That is a false positive, it is vanishingly unlikely, and it
 * fails closed.
 */
function runIdsIn(value: unknown, depth = 0, found: Set<string> = new Set()): Set<string> {
  if (depth > WALK_MAX_DEPTH) return found;
  if (typeof value === "string") {
    if (RUN_ID_RE.test(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) runIdsIn(item, depth + 1, found);
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    if (RUN_ID_KEYS.has(key) && typeof child === "string" && child !== "") found.add(child);
    runIdsIn(child, depth + 1, found);
  }
  return found;
}

/**
 * Refuse to answer with a run this agent does not own.
 *
 * One query however many ids the reply mentions — the ownership table answers
 * which of them are ours, and anything missing from that answer is a breach.
 */
export async function assertEveryRunIsOurs(
  reply: unknown,
  opts: { slug: string; sql: Sql; method: string },
): Promise<void> {
  const ids = [...runIdsIn(reply)];
  if (ids.length === 0) return;
  const rows = await opts.sql(
    `select run_id from aai_platform.workflow_run_owner
      where slug = $1 and run_id = any($2::text[])`,
    [opts.slug, ids],
  );
  const ours = new Set(rows.flatMap((r) => (typeof r.run_id === "string" ? [r.run_id] : [])));
  const foreign = ids.filter((id) => !ours.has(id));
  if (foreign.length === 0) return;
  // ERROR, not warn: every inbound check passed and the reply is still wrong, so
  // either a scope is enforced incorrectly or the DevKit returned something the
  // scope did not ask for. Both are bugs in this platform.
  log.error("refusing a reply naming a run this agent does not own", {
    slug: opts.slug,
    method: opts.method,
    runId: foreign[0],
    count: foreign.length,
  });
  throw new HTTPException(502, { message: "run storage returned an unattributable run" });
}
