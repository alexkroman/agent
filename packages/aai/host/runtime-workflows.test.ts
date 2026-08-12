// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's WORKFLOW wiring — which journal a run gets, and what happens
 * when there is none.
 *
 * Its own file because `runtime.test.ts` reached the 700-line test cap. The seam
 * is the one `setupWorkflows` draws: everything there is about a session or a
 * tool call, and these two specs are about the decision made before either
 * exists.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { workflow } from "../sdk/workflow.ts";
import { makeAgent, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

describe("workflows without storage", () => {
  test("an injected journal runs workflows with no database, and ctx.db still refuses", async () => {
    // `aai dev`'s case: try `workflow()` locally without provisioning Postgres.
    // The durability primitives have to work; `ctx.db` must not, because a
    // second in-memory thing pretending to be a database is a worse answer than
    // naming the setting.
    const { createMemoryWorkflowStore } = await import("./workflow-memory-store.ts");
    const dbErrors: string[] = [];
    const probe = workflow({
      input: z.object({}),
      async run(_input, ctx) {
        const stepped = await ctx.step("one", () => "journaled");
        await ctx.db.query("select 1").catch((err: unknown) => {
          dbErrors.push(err instanceof Error ? err.message : String(err));
        });
        return stepped;
      },
    });
    const runtime = createRuntime({
      agent: makeAgent({ workflows: { probe } }),
      env: {},
      logger: silentLogger,
      workflowStore: createMemoryWorkflowStore(),
    });

    const engine = runtime.workflows;
    expect(engine).toBeDefined();
    const runId = await engine?.start(probe, {});
    await vi.waitFor(async () => {
      expect((await engine?.get(runId as string))?.status).toBe("completed");
    });
    // The step ran and was journaled; the query was refused by name.
    expect(dbErrors[0]).toContain("storage");
    await runtime.shutdown();
  });

  test("no store and no database still boots, and ctx.workflows rejects", async () => {
    // A voice agent whose workflows are misconfigured must still answer the
    // phone, so this warns rather than throwing.
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = createRuntime({
      agent: makeAgent({ workflows: { probe: workflow({ run: () => 1 }) } }),
      env: {},
      logger,
    });
    expect(runtime.workflows).toBeUndefined();
    expect(logger.warn.mock.calls.flat().join(" ")).toContain("storage is not enabled");
    await runtime.shutdown();
  });
});
