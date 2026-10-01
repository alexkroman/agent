// Copyright 2026 the AAI authors. MIT license.
/**
 * A wait OUTLIVES the process that started it — on the home a self-hosted
 * deployment really resolves.
 *
 * `in-process.test.ts` pins the boot sweep over a shared in-memory journal, which
 * is a claim about the engine. This file is the claim about the WIRING: two
 * `buildWorkflowClient` calls, each over its OWN connection pool to one real
 * database, standing in for the process that started a run and the one that boots
 * after it. Neither is handed a journal; each resolves its home through
 * `resolveStorageHome` exactly as `createRuntime` does — so if the one ordering
 * decision ever stopped choosing Postgres for a `DATABASE_URL`, the second process
 * would boot over an empty memory journal and the run would never come back.
 *
 * ```sh
 * pnpm test:pg pnpm --filter @alexkroman1/aai-runtime test:scenario
 * ```
 */

import { workflow } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "../_pg-test-utils.ts";
import { makeLogger } from "../_test-utils.ts";
import { createPostgresDb } from "../postgres-db.ts";
import { applyWorkflowJournalDdl } from "./journal/schema.ts";
import { buildWorkflowClient } from "./runtime.ts";

/** Distinct from every other scenario suite's schema, and not app-shaped. */
const SCHEMA = "wf_wait_durability";

describeWithPg("a ctx.sleep across a process restart", () => {
  let admin: ReturnType<typeof createPostgresDb>;
  const url = (): string => `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}`;

  beforeAll(async () => {
    admin = createPostgresDb({ url: pgUrl() });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    const ddl = createPostgresDb({ url: url() });
    await applyWorkflowJournalDdl({ db: ddl, logger: makeLogger() });
    await ddl.close();
  });

  afterAll(async () => {
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.close();
  });

  test("a run suspended on a sleep by one process is finished by the next", async () => {
    // The platform pair must be ABSENT, or the home is the platform's.
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "");
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "");
    vi.stubEnv("AAI_GUEST_TOKEN", "");
    const after = vi.fn(() => "resumed");
    const agent = {
      workflows: {
        digest: workflow({
          description: "sleeps, then does one step",
          run: async (_input: unknown, ctx) => {
            await ctx.sleep("nap", 150);
            return ctx.step("after", after);
          },
        }),
      },
    };

    // Process ONE: starts the run, sees it suspend, and goes away.
    const firstDb = createPostgresDb({ url: url() });
    const first = buildWorkflowClient(agent, firstDb, undefined, makeLogger());
    if (!first) throw new Error("an agent with workflows gets a client");
    const runId = await first.client.start("digest", {});
    await vi.waitFor(async () => {
      expect(await first.client.get(runId)).toMatchObject({ status: "running" });
    });
    first.stop();
    await firstDb.close();
    // Past the deadline with nothing scheduled anywhere: only the journal remembers.
    await sleep(200);
    expect(after).not.toHaveBeenCalled();

    // Process TWO: a fresh pool, a fresh engine, nothing handed over but the URL.
    const secondDb = createPostgresDb({ url: url() });
    const logger = makeLogger();
    const second = buildWorkflowClient(agent, secondDb, undefined, logger);
    if (!second) throw new Error("an agent with workflows gets a client");
    try {
      await vi.waitFor(
        async () => {
          expect(await second.client.get(runId)).toMatchObject({
            status: "completed",
            output: "resumed",
          });
        },
        { timeout: 10_000 },
      );
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      second.stop();
      await secondDb.close();
      vi.unstubAllEnvs();
    }
  });
});
