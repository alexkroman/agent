// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a LOCAL deployment keeps a workflow's on-disk state.
 *
 * Split out of `workflow-world.ts` when the Workflow DevKit was removed, and it
 * is the half that had to survive: the DevKit owned a "local world" whose data
 * directory these two functions described, but the directory is not the DevKit's
 * idea — it is where a databaseless deployment's UPLOAD BYTES live
 * (`_upload-files.ts`), which is a question that outlives whatever executes the
 * runs.
 *
 * ## The key is OURS now, and that is a rename with a reason
 *
 * It was `WORKFLOW_LOCAL_DATA_DIR`, the DevKit's own key, and it was written by
 * `configureWorkflowWorld` — so both sides read one name and could not disagree.
 * With that writer gone the name would have been a key nothing sets, read by a
 * fallback, which is the shape of a value that is silently always the default.
 *
 * `AAI_WORKFLOW_DATA_DIR` is the same contract under a name this repo owns:
 * `aai dev` sets it to the project's own `.workflow-data`, and anything that does
 * not set it gets the per-process default and is told so at boot.
 *
 * **The one writer is `startDevServer` (`aai-cli/_dev-server.ts`)**, and for a
 * while there was none at all — the rename shipped with the reader and without
 * the writer, so every `aai dev` upload silently took the per-process default
 * and the non-default arm of `installWorkflowSupport`'s boot line was
 * unreachable. That writer imports {@link WORKFLOW_DATA_DIR_ENV} now — the name
 * is on `@alexkroman1/aai-runtime/internal`, so the two ends of one variable
 * cannot disagree about its spelling.
 *
 * @internal
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a host declares the directory.
 *
 * Read rather than recomputed by every caller, because two callers deriving it
 * independently is how they come to disagree — and a disagreement here is
 * silent: uploads under one directory, runs under another, and no error
 * anywhere.
 *
 * @internal
 */
export const WORKFLOW_DATA_DIR_ENV = "AAI_WORKFLOW_DATA_DIR";

/**
 * Where local state goes when the host names nowhere.
 *
 * Per PROCESS, which is the honest scope for a deployment with no database: its
 * journal is in memory, so a run is exactly as durable as the process holding
 * it, and a successor inheriting the directory would find uploads whose runs
 * died with its predecessor.
 *
 * It also closes a real bug, which is why it is not simply `cwd()`. A cwd is not
 * something every host PICKS — a deployed guest's is whatever its image left it
 * (`/` on the platform's snapshot image, which sets no `WORKDIR`), and under the
 * subprocess backend `aai-server/subprocess-sandbox.ts` deliberately hands every
 * guest the same neutral one. So two databaseless agents beside each other
 * shared ONE directory and each saw the other's state.
 *
 * `tmpdir()`, never a literal `/tmp` (`guard-invariants` rule 11): that string
 * is drive-relative on Windows, and `aai dev` runs on a developer's machine.
 */
function defaultLocalDataDir(): string {
  return join(tmpdir(), `aai-workflow-data-${process.pid}`);
}

/**
 * The directory this deployment keeps local workflow state in.
 *
 * The fallback is for a host that declared nothing — a self-hosted
 * `createServer` — where a per-process directory is the honest answer, that
 * host's runs being per-process too.
 *
 * @internal
 */
export function localWorkflowDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[WORKFLOW_DATA_DIR_ENV] ?? defaultLocalDataDir();
}

/**
 * Is this directory the PER-PROCESS default, rather than one a host chose?
 *
 * The difference decides whether local uploads survive a restart, and it is not
 * cosmetic. Measured both ways: under `aai dev`, which passes the project's own
 * `.workflow-data`, the same upload's bytes came back byte-identical across a
 * restart — "a restart is a save rather than a new deployment"; the same agent on
 * the scaffold's `server.mjs` got a fresh `tmpdir()/aai-workflow-data-<pid>`.
 *
 * DERIVED by comparing against {@link defaultLocalDataDir} rather than by
 * sniffing for a temp path, for the same reason {@link localWorkflowDataDir}
 * reads the env instead of recomputing: two spellings of one fact come to
 * disagree, and silently.
 *
 * @internal
 */
export function isPerProcessDataDir(dir: string): boolean {
  return dir === defaultLocalDataDir();
}
