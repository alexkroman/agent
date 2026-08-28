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
import type { SqlExec } from "./secret-store.ts";
import { ownsRuns } from "./workflow-run-owner.ts";

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
 *
 * ## Binary fields are skipped, and skipping them is what makes this affordable
 *
 * `isRecord` answers TRUE for a `Buffer` — it is a non-null, non-array object — so
 * without the view check below, `Object.entries` materializes one `[index, byte]`
 * pair per byte and this recurses on every one of them. The Postgres world hands a
 * `Buffer` back for every `bytea` column (`workflow-typed-json.ts`): a run's
 * `input`/`output`, a step's, hook metadata, every stream chunk. Measured: a single
 * 1 MiB buffer took **716 ms of synchronous event loop**, and `runs.list` multiplies
 * that by the page. With the check it is 0.2 ms, and nothing is lost — a run id is a
 * string, and bytes cannot hold one.
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
  // Before the record branch: see the module doc. A typed-array view is bytes, and
  // `isRecord` would otherwise walk it one byte at a time.
  if (ArrayBuffer.isView(value)) return found;
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
 * One query however many ids the reply mentions (`ownsRuns`) — the ownership table
 * answers which of them are ours, and anything missing from that answer is a breach.
 *
 * ## `known` is what keeps this off the hot path's second round trip
 *
 * A run-keyed call has ALREADY proven its run id ours on the way in — `dispatch`'s
 * shared `ownsRun` gate — and the reply then names that same id, so without this
 * every `events.create`, `events.get`, `steps.get` and `steps.list` paid the
 * ownership query TWICE, the second time while holding a connection reserved out of
 * a pool of `ADMIN_POOL_MAX`. That is the hottest path on this surface: one pair per
 * `step_started`/`step_completed` of every durable run.
 *
 * Subtracting it is sound rather than a shortcut. This check exists to catch a reply
 * naming a run the REQUEST never asked about, and an id the request was gated on is
 * by construction not that; it was checked against the same table, for the same
 * slug, on the same connection, moments earlier. What it must never become is a
 * caller passing ids it merely EXPECTS to be ours — only ids `ownsRun` actually
 * returned true for belong here, which is why `dispatch` is the one caller that
 * supplies it.
 */
export async function assertEveryRunIsOurs(
  reply: unknown,
  opts: { slug: string; sql: SqlExec; method: string; known?: string | undefined },
): Promise<void> {
  const known = opts.known;
  const ids = [...runIdsIn(reply)].filter((id) => id !== known);
  if (ids.length === 0) return;
  // `ownsRuns`, not a `select` of our own: `workflow-run-owner.ts` is this table's
  // one owner, and the module that would silently keep answering "fine" through a
  // schema change is the last one that should hold a second copy of the query.
  const ours = await ownsRuns(opts.sql, ids, opts.slug);
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
