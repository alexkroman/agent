// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's two store contracts, against the ONE arm the platform runs on.
 *
 * Same case lists the unit suites run over their memory arms
 * (`studio-store-conformance.ts`), same gate as `aai-server`'s half
 * (`describeWithStack`, re-exported through `aai-server/test-utils` because it
 * lives in an `_`-internal module a sibling may not import). It is a separate
 * file from `aai-server/store-conformance.scenario.test.ts` for a structural
 * reason rather than a stylistic one: these contracts' types live HERE, and
 * `aai-server` may not import this package — the dependency runs the other way.
 *
 * ```sh
 * supabase start     # applies supabase/migrations on init
 * pnpm test:pg       # resolves the stack, then runs this tier against it
 * ```
 *
 * The preview queue's arm is the REAL `pgmq`. Until the stack was resolvable,
 * `platform-schema.scenario.test.ts` hand-wrote a plpgsql `pgmq.create(text)` so
 * the migration's queue block could run against a stock server at all, and the
 * extension's own semantics — visibility timeout, redelivery, archiving — were
 * asserted against nothing but the in-memory queue.
 */

import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import type { SqlExec } from "aai-server/stores";
import { createPgWorkspaceStore } from "aai-server/stores";
import { describeWithStack, ensurePlatformTables, pgUrl } from "aai-server/test-utils";
import { afterAll, beforeAll, describe } from "vitest";
import { createPgPreviewQueue } from "./studio-preview-queue.ts";
import { createPgStudioSessionRegistry } from "./studio-session-registry.ts";
import {
  conformanceLike,
  previewQueueConformance,
  studioSessionRegistryConformance,
} from "./studio-store-conformance.ts";

describeWithStack("studio store conformance: the Supabase stack arm", () => {
  let db: CloseableDb;
  let sql: SqlExec;

  beforeAll(async () => {
    // Read inside the hook: vitest EXECUTES a `describe.skip` callback to
    // enumerate what it is skipping, so `pgUrl()` at the top of this body would
    // throw during collection rather than skip the file.
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (query, params) => db.query(query, params);
    await ensurePlatformTables(sql);
  });

  afterAll(async () => {
    // Sessions cascade off their workspace, so one sweep covers both. Queue rows
    // are acked or archived by the cases themselves.
    //
    // The pattern is THIS PROCESS's prefix, never `conf-%`: that wildcard also
    // matched `aai-server`'s conformance rows, and turbo runs the two suites in
    // parallel against this same database — so whichever finished first deleted
    // the other's live workspace and cascaded away the chat under it. This
    // comment used to say a leftover was "invisible to every other scope because
    // each case owns a `conf-*` one", which was true of the keys and silent
    // about the sweep.
    await sql("delete from aai_platform.studio_workspaces where scope like $1", [
      conformanceLike(),
    ]);
    await db?.close();
  });

  /** The workspace a session row hangs off — `on delete cascade` needs a parent. */
  const parent = async (scope: string, project: string): Promise<void> => {
    await createPgWorkspaceStore(sql).put(scope, project, { files: {} }, null);
  };

  describe("StudioSessionRegistry", () => {
    studioSessionRegistryConformance((opts) => createPgStudioSessionRegistry(sql, opts), parent);
  });

  describe("PreviewQueue (pgmq)", () => {
    previewQueueConformance(() => createPgPreviewQueue(sql));
  });
});
