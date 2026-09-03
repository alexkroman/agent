// Copyright 2026 the AAI authors. MIT license.
/**
 * The blob GC's body — mark-and-sweep over the deploy bucket, in two arms.
 *
 * Split from `pg-cron-bodies.ts` along the seam that file's own header already
 * names: "what does the blob GC delete" is a hundred lines of plpgsql and an
 * argument about mark-and-sweep safety, where every other body there is a
 * one-line `delete`. Keeping them together took that file to the 500-line cap,
 * which is exactly how it came to exist in the first place.
 *
 * `pg-cron.ts` stays the import surface — nothing outside it imports either half.
 *
 * Neither `assertSqlLiteralSafe` nor `guarded` comes along, and that is a
 * property of this body rather than an omission: it interpolates only the two
 * constants asserted where they are read, and it guards its own preconditions in
 * plpgsql (`to_regnamespace`, `to_regclass`) because it needs three of them
 * rather than one table.
 *
 * @internal
 */

import { UPLOAD_KEY_PREFIX } from "@alexkroman1/aai-runtime";
import { assertSqlLiteralSafe } from "./pg-cron-bodies.ts";
import { PLATFORM_STORAGE_KEY_SECRET } from "./secret-store.ts";

// The Vault NAME this body looks its Storage key up by.
assertSqlLiteralSafe(PLATFORM_STORAGE_KEY_SECRET, "PLATFORM_STORAGE_KEY_SECRET");
// The prefix the uploads arm matches on. It owes one rule beyond the
// LIKE-wildcard one: it must be a SINGLE path segment, because that arm reads
// the slug and the id back out of a key by position (`split_part(name, '/', 2)`
// and `3`). A nested prefix would shift both and the arm would join on the wrong
// halves of somebody's key.
assertSqlLiteralSafe(UPLOAD_KEY_PREFIX, "UPLOAD_KEY_PREFIX");
if (UPLOAD_KEY_PREFIX.includes("/")) {
  throw new Error(
    `UPLOAD_KEY_PREFIX = ${JSON.stringify(UPLOAD_KEY_PREFIX)} must be one path segment: the ` +
      "blob GC's uploads arm reads an object key's slug and id by position, which a nested " +
      "prefix shifts.",
  );
}

/**
 * How long an object may sit under `uploads/` unrecorded before the GC's uploads
 * arm treats it as garbage.
 *
 * The one interval in this file that is a SAFETY bound rather than a retention
 * policy, so the reasoning is written down instead of "a generous window".
 *
 * An upload's bytes normally arrive AFTER its record: `stream` and `beginParts`
 * both write the row first, precisely so a run can be started on an upload that
 * is still arriving. **`create` is the exception** — it writes its windows first
 * and its row last, so that an upload exists only once all of its bytes do
 * (`_upload-store-blobs.ts` says so at the call site). Between the first window
 * and that row there is an object no record names, and reclaiming one would
 * destroy an upload in flight.
 *
 * That gap is bounded by ONE REQUEST. `create` receives the whole body inside a
 * single guest request, so it cannot outlive the sandbox serving it, and
 * `SANDBOX_TIMEOUT_SECS` clamps a sandbox's life to at most 86,400 seconds
 * (`modal-sandbox-env.ts`). Three days is three times that hard ceiling. It is
 * also far past `UPLOAD_READ_URL_TTL_SECONDS` (5 min), so a signed URL cannot
 * outlive the window protecting the object it names — the same property the
 * blobs arm's day buys against the worker-bundle URL.
 *
 * **The tripwire: raising that clamp past a day invalidates this number.** It is
 * the only change that can, which is why the clamp is named rather than assumed.
 */
const UPLOAD_ORPHAN_GRACE = "3 days";

/** Objects one ARM deletes per pass — see the fan-out bullet in {@link sweepBlobGc}. */
const GC_MAX_PER_TICK = 500;

/**
 * The one credential-bearing statement in this file, written once.
 *
 * Both arms delete the same way and must keep deleting the same way: through the
 * Storage API with a Vault-resolved key, never `delete from storage.objects`.
 * Spelled out twice, the URL shape, the header shape and that rule are all things
 * one arm can quietly stop doing.
 */
function deleteTargetObject(base: string, bucket: string): string {
  return `perform net.http_delete(
      url := '${base}/storage/v1/object/${bucket}/' || target.name,
      headers := jsonb_build_object(
        'apikey', storage_key,
        'Authorization', 'Bearer ' || storage_key
      )
    )`;
}

/**
 * Unreferenced objects in the deploy bucket: deploy BLOBS and upload WINDOWS,
 * one arm each, behind one set of guards.
 *
 * ## The blobs arm — `blobs/<sha256>`
 *
 * Blobs are content-addressed and immutable, and no referrer may delete one
 * (two agents with an identical file share a key), so nothing has ever deleted
 * them — every deploy that changes a byte writes a new ~8 MB worker bundle
 * that stays forever, including for agents since deleted and previews the
 * hourly sweep reaped. Mark-and-sweep is safe precisely BECAUSE the keys are
 * hashes: the live set is every `worker_hash` plus every value of
 * `client_files`, and a blob outside it is unreferenced by construction.
 *
 * Four things make this safe to run unattended, and each is load-bearing:
 *
 *   * **It refuses to run against an empty agents table.** Reading zero
 *     referenced hashes and deleting everything not in that set is the
 *     catastrophic failure mode, and it is one bad read away — a truncated
 *     table, a wrong database, a migration mid-flight. A platform with agents
 *     always has rows; one without has nothing worth reclaiming.
 *   * **A generous grace window.** A day is far past the retirement drain
 *     (10 min) and the signed-URL TTL (5 min), so an object cannot be swept
 *     while a spawn is still reaching for it. The cost of being slow here is
 *     storage; the cost of being fast is a failed deploy.
 *   * **Bounded per run.** 500 deletes an hour reclaims steadily without
 *     turning one sweep into a stampede against the Storage API.
 *   * **The delete goes through the Storage API, never `storage.objects`.**
 *     Deleting the row leaves the S3 object behind AND removes the only record
 *     that it exists — strictly worse than doing nothing. `pg_net` is how a
 *     SQL job calls an API, and it is fire-and-forget: a failed delete simply
 *     leaves the object for the next run to find, so the sweep is
 *     self-healing without any retry bookkeeping.
 *
 * Everything is guarded so a project without `pg_net`, without Vault, or
 * without the stored key no-ops rather than erroring hourly.
 *
 * ## The uploads arm — `uploads/<slug>/<id>/<offset>`
 *
 * **Nothing in this platform had ever deleted an uploaded byte.** `BlobStorage`
 * has no delete method, this GC matched `blobs/%` and an upload window is not
 * under `blobs/`, and `SWEEP_UPLOAD_RECORDS` reclaims the ROW. So deleting an
 * agent cascaded its `workflow_uploads` rows away and left every window of every
 * recording in the bucket forever — permanently unreachable AND permanently paid
 * for, with nothing left in the platform that even named them.
 *
 * The referrer set is the RECORD, and it is as strong here as the hash set is for
 * blobs. Every reader resolves `workflow_uploads` before it touches a window —
 * `read` and `info` both go through the record for the size and the part list —
 * so an object whose `(slug, id)` has no row is UNREADABLE by construction, not
 * merely unreferenced. Two consequences worth naming: `workflow_uploads.slug` is
 * `on delete cascade` from `agents`, so this arm reclaims a deleted agent's
 * uploads without `deleteAgent` growing a step it would then owe the orphan reap
 * (`pg-cron-delete-parity.test.ts`); and it chains onto `SWEEP_UPLOAD_RECORDS`,
 * whose expiry is the signal rather than a coincidence.
 *
 * Three things beyond the shared guards make it safe:
 *
 *   * **{@link UPLOAD_ORPHAN_GRACE}, which exists for `create` and nothing else.**
 *     Bytes precede the record in exactly one method; that constant carries the
 *     bound and the tripwire that would invalidate it.
 *   * **Its own empty-table guard.** An empty `workflow_uploads` means what an
 *     empty `agents` does — possibly a bad read — and gets the same answer:
 *     reclaim nothing. It costs a platform whose uploads are ALL garbage the
 *     reclamation, which is the trade the blobs arm already makes.
 *   * **It only deletes a key it can fully PARSE.** The regex is the shape
 *     `uploadKey` writes, and the only shape whose slug and id can be read back
 *     out by position. Anything else under the prefix is left for a human: a key
 *     this sweep cannot decompose is a key it cannot prove is garbage.
 *
 * What the arm deliberately leaves behind: an unparsable key, and everything at
 * all while either table reads empty.
 */
export function sweepBlobGc(storage: { url: string; bucket: string }): string {
  const base = storage.url.replace(/\/+$/, "");
  const deleteTarget = deleteTargetObject(base, storage.bucket);
  return `do $$
declare
  target record;
  storage_key text;
  live_agents bigint;
  live_uploads bigint;
begin
  if to_regnamespace('net') is null or to_regclass('storage.objects') is null then
    return;
  end if;
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  select decrypted_secret into storage_key from vault.decrypted_secrets
    where name = '${PLATFORM_STORAGE_KEY_SECRET}';
  if storage_key is null then
    return;
  end if;
  -- The empty-table guard. Never derive "unreferenced" from a set that may
  -- simply have failed to load.
  select count(*) into live_agents from aai_platform.agents;
  if live_agents = 0 then
    return;
  end if;
  for target in
    with referenced as (
      select worker_hash as hash from aai_platform.agents
      union
      select f.value from aai_platform.agents a, jsonb_each_text(a.client_files) f
    )
    select o.name
    from storage.objects o
    where o.bucket_id = '${storage.bucket}'
      and o.name like 'blobs/%'
      and o.created_at < now() - interval '1 day'
      and not exists (
        select 1 from referenced r where r.hash = substring(o.name from 7)
      )
    limit ${GC_MAX_PER_TICK}
  loop
    ${deleteTarget};
  end loop;
  -- The uploads arm. Its own empty-table guard, for the same reason the agents
  -- one exists: an upload record IS the referrer, so a table that failed to load
  -- would condemn every recording in the bucket.
  select count(*) into live_uploads from aai_platform.workflow_uploads;
  if live_uploads = 0 then
    return;
  end if;
  for target in
    select o.name
    from storage.objects o
    where o.bucket_id = '${storage.bucket}'
      and o.name like '${UPLOAD_KEY_PREFIX}/%'
      -- Only a key this sweep can decompose. The LIKE above is what the bucket's
      -- (bucket_id, name) index can use; this is what makes the split_part below
      -- meaningful rather than a guess at somebody's key.
      and o.name ~ '^${UPLOAD_KEY_PREFIX}/[^/]+/[^/]+/[0-9]+$'
      and o.created_at < now() - interval '${UPLOAD_ORPHAN_GRACE}'
      and not exists (
        select 1 from aai_platform.workflow_uploads u
        where u.slug = split_part(o.name, '/', 2)
          and u.id = split_part(o.name, '/', 3)
      )
    limit ${GC_MAX_PER_TICK}
  loop
    ${deleteTarget};
  end loop;
end $$`;
}

/** Where deploy blobs live, when this deployment has object storage at all. */
export type PlatformCronStorage = {
  /** Supabase project URL (`https://<ref>.supabase.co`). */
  url: string;
  /** The deploy-artifact bucket. */
  bucket: string;
};
