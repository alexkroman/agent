// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things a process must publish before its `"use step"` functions can
 * do their job: somewhere to read uploads from, and somewhere to report to.
 *
 * Both are `Symbol.for` slots rather than imports, for the reason
 * `sdk/step-env.ts` states — the step artifact bundles its own copy of the SDK,
 * so the publisher and the reader are two module instances in one realm — and
 * both are published HERE, in one call, because they have one correct wiring
 * point: `createServer`. That is the front door `aai dev`, a self-hosted server
 * and every deployed guest all go through, which is what makes a step behave
 * identically in all three.
 *
 * Publishing at the SERVER rather than at the runtime is deliberate. A guest
 * builds its runtime lazily, on the first request that needs one, while the
 * DevKit's queue can dispatch a step the moment the process boots — a run that
 * was mid-flight when the last container went away resumes exactly then. A
 * reader published from the runtime would therefore be missing for precisely
 * the steps that matter most.
 */

import { omitUndefined } from "../sdk/omit-undefined.ts";
import { publishStepFetch } from "../sdk/step-fetch.ts";
import { publishStepReporter } from "../sdk/step-report.ts";
import { publishUploadReader } from "../sdk/step-uploads.ts";
import { MAX_UPLOAD_BYTES_ENV } from "../sdk/upload-constants.ts";
import { type CloseableDb, createPostgresDb } from "./postgres-db.ts";
import type { Logger } from "./runtime-config.ts";
import { createStepFetch } from "./step-fetch.ts";
import { createStepReporter } from "./workflow-report.ts";
import { createUploadStore, resolveUploadBlobs, type UploadStore } from "./workflow-uploads.ts";

/**
 * How many connections the upload pool may hold.
 *
 * Two, and it went back DOWN when the bytes left the database. It was sized off the
 * client's fan-out — `UPLOAD_PART_CONCURRENCY + 2` — because every concurrent `PUT`
 * was a request writing chunk ROWS for as long as it lasted, so the parallelism the
 * fan-out exists for was being serialized back down by the store behind it. A part
 * is now one small `update` naming a window that landed, which holds a connection
 * for a round trip rather than for a megabyte, so the pool no longer has to be as
 * wide as the fan-out. Two is one writer plus the reader that runs WHILE a file is
 * arriving, which is the shape the streaming flow is built on: a run polls `info`
 * and reads windows through `readUpload`.
 *
 * That the number could come back down is the measurable half of the change — see
 * `_upload-blobs.ts`, "The pool".
 */
const UPLOAD_DB_POOL = 2;

/**
 * What one server's workflow support OWNS, so it can give it back.
 *
 * The `close` half is the whole reason this is an object rather than the store
 * on its own. `aai dev` re-runs `createServer` on every file save and
 * `AgentServer.close()` closed the runtime and the sockets and nothing else, so
 * each rebuild stranded a Postgres pool (2 connections, against a documented
 * 4-connection limit — two saves that touched uploads exhausted it) and an
 * undici keep-alive pool. `runtime.ts` fixed exactly this shape for `ownedDb`,
 * with a comment naming the same cause; the same rule applies here, and for the
 * same reason it is stated as OWNERSHIP: what this call opened is what it
 * closes, and a caller-injected handle would stay the caller's.
 *
 * Not exported from `/runtime`: `createServer` is the only caller and takes it
 * by inference.
 *
 * @internal
 */
type WorkflowSupport = {
  /** Where uploaded files go — what `createWorkflowApi` mounts. */
  uploads: UploadStore;
  /** Release the pools this call opened. Never rejects. */
  close(): Promise<void>;
};

/**
 * Build the upload store for one server and publish all three step slots.
 *
 * An upload needs BOTH halves — `DATABASE_URL` for the record and somewhere to put
 * the bytes — and a server missing either gets a store that refuses by name
 * (`createUnavailableUploadStore`). There is deliberately no local-directory
 * fallback any more: it stored a dev upload perfectly well and lost it by the time
 * a resumed run read it, with nothing reporting a thing.
 *
 * @internal
 */
export function installWorkflowSupport(opts: {
  /**
   * The agent's env. Read for `DATABASE_URL`, the upload cap, and the three
   * `AAI_UPLOAD_STORAGE_*` keys — nothing else. Taking the RECORD rather than the
   * values keeps the key names in one module; the caller would otherwise spell them
   * at the call site, which is where they drift.
   */
  env?: Record<string, string> | undefined;
  /**
   * Base URL of a platform serving this agent's upload bytes, when there is one.
   *
   * Its PRESENCE selects the brokered byte path, which is the security boundary rather
   * than a preference — see `resolveUploadBlobs`, and `ServerOptions.uploadBroker` for
   * why this is not `publicUrl`.
   */
  uploadBroker?: string | undefined;
  logger: Logger;
}): WorkflowSupport {
  // A pool of its own rather than the runtime's `ctx.db`: the runtime is built
  // lazily and may not exist yet (see the module doc), and `createPostgresDb`
  // connects on first query, so an agent that never uploads anything pays
  // nothing for holding this handle.
  const databaseUrl = opts.env?.DATABASE_URL;
  const db: CloseableDb | undefined = databaseUrl
    ? createPostgresDb({ url: databaseUrl, max: UPLOAD_DB_POOL })
    : undefined;
  const store = createUploadStore({
    db,
    ...omitUndefined({
      blobs: resolveUploadBlobs(omitUndefined({ env: opts.env, broker: opts.uploadBroker })),
      // A value that is not a positive number is IGNORED rather than treated as
      // zero: a typo'd env var must not make every upload fail as "too large".
      // An operator knob rather than a tuning one: what it bounds is how much of
      // their storage one upload may take, and only they know that.
      maxBytes: positiveBytes(opts.env?.[MAX_UPLOAD_BYTES_ENV]),
    }),
  });
  publishUploadReader(store);
  publishStepReporter(createStepReporter(opts.logger));
  // The third step slot, and the one whose absence is silent: an unpublished
  // `stepFetch` degrades to `globalThis.fetch`, which WORKS and speaks HTTP/2 —
  // so a fan-out that lost this line would collect stream resets rather than an
  // error naming the gap. See `sdk/step-fetch.ts`.
  const stepFetch = createStepFetch();
  publishStepFetch(stepFetch.fetch);
  return {
    uploads: store,
    async close(): Promise<void> {
      // Settled rather than awaited in sequence, and never rejecting: this runs
      // inside `AgentServer.close()`, where one pool refusing to drain must not
      // leave the other one open — nor turn an orderly shutdown into a throw.
      await Promise.allSettled([db?.close(), stepFetch.close()]);
    },
  };
}

/** A byte count out of an env value, or `undefined` for anything unusable. */
function positiveBytes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
