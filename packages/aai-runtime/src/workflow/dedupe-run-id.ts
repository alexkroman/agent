// Copyright 2026 the AAI authors. MIT license.
/**
 * The run id a `start(…, { dedupeKey })` derives, instead of minting one.
 *
 * Deriving it is the whole mechanism, and it needs nothing from any store:
 * every journal backend already refuses a second `createRun` for an id that
 * exists (the memory map, Postgres's primary key, the platform's 409), so two
 * starts carrying one key — a webhook redelivered while the first delivery is
 * still in flight — meet at ONE insert and exactly one wins. The loser, and any
 * later start, finds the run by id and answers it. A dedupe TABLE beside the
 * runs would be a second write that a crash can separate from the first; this
 * has no second write.
 *
 * The shape is the in-process minter's — `wrun_` plus 32 hex characters — so a
 * derived id is indistinguishable from a minted one to every reader, the HTTP
 * route's id grammar and the platform's journal included. It is a hash of the
 * workflow's DECLARED name and the key, so the same key under two workflows is
 * two runs, and a redeploy that keeps the name keeps the dedupe.
 *
 * @internal
 */

import { createHash } from "node:crypto";

/** The run id for `dedupeKey` under `workflow`. */
export function dedupedRunId(workflow: string, dedupeKey: string): string {
  // `\u0000` between the two, never a raw NUL byte (it makes the file binary to
  // `git grep`), and a separator no declared name can contain, so ("a", "b:c")
  // and ("a:b", "c") hash apart.
  const digest = createHash("sha256").update(`${workflow}\u0000${dedupeKey}`).digest("hex");
  return `wrun_${digest.slice(0, 32)}`;
}
