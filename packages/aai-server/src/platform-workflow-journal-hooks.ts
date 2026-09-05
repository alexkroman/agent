// Copyright 2026 the AAI authors. MIT license.
/**
 * One outstanding HOOK window, on the platform's own database.
 *
 * Split from `platform-workflow-journal.ts` at the seam that file already had:
 * the run, step, attempt and sleep tables answer "what has this run DONE", and
 * these three answer "may this wait still be answered". Every property that file
 * states holds here too — the slug is `$1` of every statement and comes from the
 * bearer, and `payload` binds `::text::jsonb` — and `platform-workflow-journal.ts`
 * re-exports all of it, so a caller sees one journal.
 *
 * Both mutating statements are COMPARE-AND-SETs, and both were read-then-write
 * once. Their own docs carry what that cost.
 *
 * @internal
 */

import { firstWriteWins } from "@alexkroman1/aai-runtime/internal";
import { text } from "./platform-workflow-journal-rows.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * The hook table.
 *
 * Exported because `setStatus`'s release CTE reaches it — a terminal run gives
 * its tokens back — and the two must name one table.
 *
 * @internal
 */
export const HOOKS = "aai_platform.workflow_hooks";

/** One hook window. */
export type JournalHookRow = {
  token: string;
  delivered: boolean;
  payload: string | undefined;
  closed: boolean;
};

/**
 * Raised when a hook token is already held by a DIFFERENT wait.
 *
 * Its own error rather than a plain one, for the reason
 * `PlatformUploadIdTakenError` is: the caller's answer is an HTTP status, and
 * every plain `Error` reaching `withReserved` becomes a **503** — "come back
 * later" for a condition that cannot change while the holder is alive. The guest
 * then retries a permanent refusal and spends the message's whole attempt budget
 * on it, where the engine should be failing the run and saying why.
 */
export class PlatformWorkflowHookTokenError extends Error {
  constructor(holder: string | undefined) {
    super(
      holder === undefined
        ? "workflow hook token already held by another wait"
        : `workflow hook token already held by run ${holder}`,
    );
    this.name = "PlatformWorkflowHookTokenError";
  }
}

/**
 * Open a hook window, or read the one already open.
 *
 * A token another RUN holds is refused rather than overwritten: a token is what a
 * third party dials, so two runs sharing one means a payload delivered to the
 * wrong body. A re-claim by the same run and key is what a replay does and is the
 * ordinary path.
 *
 * **ONE statement, and the INSERT is the claim.** The ownership `select` and the
 * insert used to be two round trips on an untransacted connection, so two runs of
 * one agent claiming the same DERIVED token concurrently both read no owner and
 * the loser tripped `workflow_hooks_token_idx` — a raw `23505` instead of the
 * authored refusal, and both spellings came back as a plain `Error`, i.e. a 503.
 * `on conflict do nothing` with NO target absorbs both unique indexes, so 23505
 * is unreachable here; the row the statement then reports is what decides whether
 * the claim was ours.
 *
 * The main query reads the pre-statement snapshot and cannot see the CTE's own
 * insert, which is why the two halves are `union all`ed rather than selected
 * afterwards.
 *
 * **Zero rows is INDETERMINATE, and reporting it as the conflict was a bug.** It
 * means something invisible to that snapshot blocked the insert — a rival's
 * UNCOMMITTED claim, of this same window as readily as of the token — and calling
 * that a conflict answers 409 to a claim that was about to succeed. A 409 here is
 * not a retry: it is `claimHook` telling the engine the token is taken, so the
 * body's `waitFor` fails and a saga COMPENSATES. That is the shape the memory
 * backend's own comment describes ("a second recap in one session hit
 * `claimHook`'s conflict, which is not a suspend, so the saga compensated and
 * deleted that transcript too"), reachable here by a race rather than by a
 * released token. So the statement is re-run while the answer is empty
 * ({@link firstWriteWins}), and 409 is answered only when an owner is really
 * VISIBLE.
 */
export async function claimHook(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
  token: string,
): Promise<JournalHookRow> {
  return await firstWriteWins(
    async () => {
      const rows = await sql(
        `with claimed as (
           insert into ${HOOKS} (slug, run_id, key, token)
           values ($1, $2, $3, $4)
           on conflict do nothing
           returning run_id, key, token, delivered, payload::text as payload, closed
         )
         select run_id, key, token, delivered, payload, closed from claimed
         union all
         select run_id, key, token, delivered, payload::text as payload, closed
           from ${HOOKS}
          where slug = $1 and ((run_id = $2 and key = $3) or token = $4)`,
        [slug, runId, key, token],
      );
      // Empty is the indeterminate answer, and the ONLY one worth re-running: a
      // visible owner is a decision, so it is thrown from inside and the retry
      // never sees it.
      const owner = rows[0];
      if (!owner) return;
      const mine = rows.find((row) => String(row.run_id) === runId && String(row.key) === key);
      if (!mine) throw new PlatformWorkflowHookTokenError(String(owner.run_id));
      return {
        token: String(mine.token),
        delivered: Boolean(mine.delivered),
        payload: text(mine.payload),
        closed: Boolean(mine.closed),
      };
    },
    () => `workflow hook ${key} could not be claimed for run ${runId}`,
  );
}

/**
 * Close a window the run has moved past, so a late delivery is refused.
 *
 * A COMPARE-AND-SET on `delivered`, mirroring the self-hosted twin, and the
 * `delivered = false` in the `where` is the whole of it: the engine reads the
 * deadline and then closes, and a signal landing between the two must WIN. Closed
 * unconditionally, this walk of the body took the timed-out branch while every
 * later replay read the payload and took the answered one — the divergence
 * `closed` exists to prevent, arriving by the other door.
 *
 * Answers `true` when no signal may be taken through this window (closed now,
 * already closed, or gone — a terminal run releases its tokens), and `false` ONLY
 * when it was already ANSWERED, which is the caller's instruction to take the
 * answered branch instead.
 */
export async function closeHook(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
): Promise<boolean> {
  const rows = await sql(
    `with shut as (
       update ${HOOKS} set closed = true
        where slug = $1 and run_id = $2 and key = $3 and delivered = false
        returning key
     )
     select (select count(*) from shut) as closed,
            (select count(*) from ${HOOKS}
              where slug = $1 and run_id = $2 and key = $3) as existing`,
    [slug, runId, key],
  );
  const row = rows[0];
  if (!row) return true;
  return Number(row.closed) > 0 || Number(row.existing) === 0;
}

/**
 * Deliver a payload, and answer which run to re-walk.
 *
 * Already answered, or the window closed: both are the same refusal for the same
 * reason — a body is replayed and must read the same answer every time, or two
 * walks of it diverge. The `where` is what makes that atomic.
 */
export async function deliverHook(
  sql: SqlExec,
  slug: string,
  token: string,
  payload: string | undefined,
): Promise<string | undefined> {
  const rows = await sql(
    `update ${HOOKS}
        set delivered = true, payload = $3::text::jsonb
      where slug = $1 and token = $2 and delivered = false and closed = false
      returning run_id`,
    [slug, token, payload ?? null],
  );
  const row = rows[0];
  return row ? String(row.run_id) : undefined;
}
