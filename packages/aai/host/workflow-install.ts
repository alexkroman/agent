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

import { join } from "node:path";
import type { Db } from "../sdk/db.ts";
import { publishStepReporter } from "../sdk/step-report.ts";
import { publishUploadReader } from "../sdk/step-uploads.ts";
import { createPostgresDb } from "./postgres-db.ts";
import type { Logger } from "./runtime-config.ts";
import { createStepReporter } from "./workflow-report.ts";
import { createUploadStore, type UploadStore } from "./workflow-uploads.ts";

/**
 * Where the file backend keeps uploads when there is no database.
 *
 * Inside the Local World's own directory, so a project has ONE place its dev
 * workflow state lives and one thing to delete to start over.
 */
export const UPLOAD_DIR_NAME = join(".workflow-data", "uploads");

/** How many connections the upload pool may hold. */
const UPLOAD_DB_POOL = 2;

/**
 * Build the upload store for one server and publish both step slots.
 *
 * @param opts.databaseUrl - The app's database, when it has one. Present picks
 *   the Postgres backend, which is the only durable one — an upload in a
 *   container's filesystem is gone by the time a resumed run reads it.
 * @param opts.dataDir - Project directory the file backend's folder hangs off.
 *   Defaults to `process.cwd()`, matching what the Local World does with its
 *   own state.
 * @internal
 */
export function installWorkflowSupport(opts: {
  databaseUrl?: string | undefined;
  dataDir?: string | undefined;
  logger: Logger;
}): UploadStore {
  // A pool of its own rather than the runtime's `ctx.db`: the runtime is built
  // lazily and may not exist yet (see the module doc), and `createPostgresDb`
  // connects on first query, so an agent that never uploads anything pays
  // nothing for holding this handle.
  const db: Db | undefined = opts.databaseUrl
    ? createPostgresDb({ url: opts.databaseUrl, max: UPLOAD_DB_POOL })
    : undefined;
  const store = createUploadStore({
    db,
    dir: join(opts.dataDir ?? process.cwd(), UPLOAD_DIR_NAME),
  });
  publishUploadReader(store);
  publishStepReporter(createStepReporter(opts.logger));
  return store;
}
