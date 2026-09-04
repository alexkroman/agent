// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable work queue behind auto preview deploys.
 *
 * Scheduling used to be pure in-process state: a map of in-flight projects
 * with a dirty bit, fire-and-forget. That loses work on any replica restart
 * or mid-deploy sandbox death — and the symptom is bad, because the workspace
 * has already been written: the Preview pane sits on "Updating preview…"
 * with nothing actually on the way until the next edit. The recovery for it
 * was `wakeProjectPreview` re-scheduling when someone next OPENED the
 * project, which is not a recovery so much as a hope.
 *
 * So the schedule is a row now, in Supabase's own queue extension
 * (`pgmq` — pgmq is available in Supabase Postgres, alongside pg_cron and
 * Vault, which the platform already uses). What that buys, none of which is
 * worth hand-rolling:
 *
 * - **At-least-once delivery.** A claimed job is invisible for a visibility
 *   timeout, not deleted. A replica that dies mid-deploy doesn't consume the
 *   job — it becomes visible again and another replica runs it.
 * - **A retry count**, so a job that keeps failing is archived rather than
 *   redelivered forever (`pgmq.archive` moves it to the queue's archive
 *   table, where it can be inspected).
 * - **Fleet-wide drain.** Any replica can serve any project's preview,
 *   matching the rest of the stateless-server design.
 *
 * Coalescing is NOT the queue's job and does not need to be: the deploy
 * re-reads the workspace and no-ops when `previewHash` already matches the
 * current files, so a duplicate job is a cheap read. Per-project
 * serialization comes from the drain's keyed lock. That is why N queued jobs
 * for one project cost one deploy, without the queue knowing anything about
 * projects.
 *
 * Two implementations behind one interface, matching every other platform
 * store: pgmq in production, an in-memory array in dev/tests.
 */

import { safeJsonParse } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { createLogger } from "aai-server/logger";
import type { SqlExec } from "aai-server/secret-store";

const log = createLogger("studio.preview.queue");

/** The pgmq queue name. Also the prefix of its archive table. */
export const PREVIEW_QUEUE = "aai_studio_preview";

/**
 * How long a claimed job stays invisible. Must comfortably exceed a preview
 * deploy (spawn + build + upload — seconds, occasionally tens of seconds):
 * too short and a slow-but-healthy deploy is redelivered and run twice
 * concurrently, which the drain's keyed lock only prevents WITHIN one replica.
 */
export const PREVIEW_JOB_VISIBILITY_MS = 5 * 60_000;

/**
 * Deliveries before a job is archived instead of retried. A preview deploy
 * that fails for a REASON (a build error) stamps `previewError` and counts as
 * done, so reaching this many redeliveries means the job kept dying without
 * settling — a crash loop, not a broken workspace.
 */
export const PREVIEW_JOB_MAX_ATTEMPTS = 5;

/**
 * One unit of preview work. Deliberately carries NO credential: this is a
 * durable Postgres row, and a user's AssemblyAI key has no business in one.
 * The drain resolves the key from Vault by `userId`; see the deployer for
 * what happens to jobs that have no `userId` to resolve from.
 */
export type PreviewJob = {
  scope: string;
  project: string;
  /** Public platform origin the in-guest `aai deploy` targets. */
  serverUrl: string;
  /** Studio user whose stored key the deploy runs on, when there is one. */
  userId?: string;
};

/** A claimed job plus what the drain needs to settle or retry it. */
export type ClaimedPreviewJob = {
  /** Queue-assigned id, passed back to `ack`/`archive`. */
  id: string;
  job: PreviewJob;
  /** How many times this job has been delivered, including now (≥ 1). */
  attempts: number;
};

export type PreviewQueue = {
  /** Add a job. Duplicates are fine and expected — see the module doc. */
  enqueue(job: PreviewJob): Promise<void>;
  /**
   * Take up to `max` visible jobs, hiding them for the visibility timeout.
   * Returns [] when the queue is empty.
   */
  claim(max: number): Promise<ClaimedPreviewJob[]>;
  /** Remove a finished job. */
  ack(id: string): Promise<void>;
  /** Move a job out of the queue for inspection instead of retrying it. */
  archive(id: string): Promise<void>;
};

/**
 * Shape a queue row's `message` must have to be worth running.
 *
 * A jsonb column reaches here as a STRING, not an object, and that is the
 * normal case rather than a corner: jobs are bound as JSON text with a
 * `::jsonb` cast (the platform-wide pattern — see `enqueue` below), which
 * stores a jsonb *string* rather than an object, so the driver hands the
 * string straight back. Every sibling store carries the same tolerance and
 * documents it — `parseDoc` in aai-server/workspace-store.ts, and the notes
 * in agent-store.ts / chat-store.ts. Without it, EVERY job was archived as
 * unreadable on its first claim and previews stopped deploying platform-wide,
 * reported only by one `console.warn` per job.
 */
function parseJob(raw: unknown): PreviewJob | null {
  // Non-JSON text is a genuinely unreadable payload, not a crash — `safeJsonParse`
  // returns undefined, which the object check below rejects like any other shape.
  const value = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!isRecord(value)) return null;
  const { scope, project, serverUrl, userId } = value;
  if (typeof scope !== "string" || typeof project !== "string") return null;
  if (typeof serverUrl !== "string") return null;
  return { scope, project, serverUrl, ...(typeof userId === "string" && { userId }) };
}

/**
 * pgmq-backed queue over the platform admin connection.
 *
 * The extension and the queue itself are declared in
 * `supabase/migrations/*_platform_schema.sql`, so there is no lazy DDL here —
 * a missing queue fails loudly on the first send rather than being created
 * under whatever connection happened to notice.
 */
export function createPgPreviewQueue(sql: SqlExec): PreviewQueue {
  // Named rather than reached through `this` inside `claim`: the unreadable-job
  // path is the one caller, and a method that depends on its receiver breaks
  // the moment the queue is destructured or wrapped (the test doubles do both).
  const archive = async (id: string): Promise<void> => {
    await sql("select pgmq.archive($1, $2::bigint)", [PREVIEW_QUEUE, id]);
  };

  return {
    async enqueue(job) {
      await sql("select pgmq.send($1, $2::text::jsonb)", [PREVIEW_QUEUE, JSON.stringify(job)]);
    },

    async claim(max) {
      const rows = await sql("select * from pgmq.read($1, $2::int, $3::int)", [
        PREVIEW_QUEUE,
        Math.ceil(PREVIEW_JOB_VISIBILITY_MS / 1000),
        max,
      ]);
      const claimed: ClaimedPreviewJob[] = [];
      for (const row of rows) {
        const id = String(row.msg_id);
        const job = parseJob(row.message);
        if (!job) {
          // Unreadable payload: archive rather than redeliver forever. This
          // is how a job written by an older/newer shape stops costing us a
          // redelivery every visibility timeout.
          log.warn("archiving unreadable job", { id });
          await archive(id).catch(() => undefined);
          continue;
        }
        claimed.push({ id, job, attempts: Number(row.read_ct ?? 1) });
      }
      return claimed;
    },

    async ack(id) {
      await sql("select pgmq.delete($1, $2::bigint)", [PREVIEW_QUEUE, id]);
    },

    archive,
  };
}

/**
 * The memory arm's shape: the CONTRACT, plus the one test seam.
 *
 * Declared rather than written inline as `PreviewQueue & { archived }` so the
 * relationship is checked from both sides — `konsistent.json`'s
 * `studio-store-arms` pins this interface as extending `PreviewQueue` and pins
 * the factory as returning it, where an inline intersection is a shape no
 * structural rule can read (konsistent matches the written annotation, so
 * `PreviewQueue & { … }` is not `PreviewQueue`). The seam itself is real and
 * stays: four specs and the concurrency fuzz harness read what the queue
 * archived, and archiving is the one queue outcome that has no other
 * observable — an acked job and an archived one both simply leave.
 */
export interface MemoryPreviewQueue extends PreviewQueue {
  /** Jobs moved out of the queue for inspection instead of retried. */
  readonly archived: ClaimedPreviewJob[];
}

/**
 * In-memory queue for local dev and tests — one process, so the visibility
 * timeout only has to model "a claimed job is not claimed twice", which it
 * does by timestamp exactly as pgmq does.
 */
export function createMemoryPreviewQueue(opts: { now?: () => number } = {}): MemoryPreviewQueue {
  const now = opts.now ?? (() => Date.now());
  type Row = { id: string; job: PreviewJob; visibleAt: number; reads: number };
  const rows = new Map<string, Row>();
  const archived: ClaimedPreviewJob[] = [];
  let nextId = 1;

  return {
    archived,
    enqueue(job) {
      const id = String(nextId++);
      rows.set(id, { id, job, visibleAt: 0, reads: 0 });
      return Promise.resolve();
    },
    claim(max) {
      const claimed: ClaimedPreviewJob[] = [];
      // One clock reading for the whole claim, so every job in a batch gets
      // the same visibility window (and a stubbed `now` is read once).
      const at = now();
      for (const row of rows.values()) {
        if (claimed.length >= max) break;
        if (row.visibleAt > at) continue;
        row.visibleAt = at + PREVIEW_JOB_VISIBILITY_MS;
        row.reads++;
        claimed.push({ id: row.id, job: row.job, attempts: row.reads });
      }
      return Promise.resolve(claimed);
    },
    ack(id) {
      rows.delete(id);
      return Promise.resolve();
    },
    archive(id) {
      const row = rows.get(id);
      if (row) archived.push({ id, job: row.job, attempts: row.reads });
      rows.delete(id);
      return Promise.resolve();
    },
  };
}
