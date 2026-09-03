// Copyright 2026 the AAI authors. MIT license.
/**
 * A workflow's declared OUTPUT schema, end to end: what it does to a run that
 * completes, and what it puts in the listing.
 *
 * Its own file rather than an arm of `workflow-engine.test.ts` because the two
 * halves have one subject and two homes — the engine decides what a settled walk
 * makes the run (`workflow-output.ts`), and `workflow-client.ts` converts the
 * same declaration for a browser. A spec that could see only one of them would
 * miss the property that matters: what a caller READS back is the parsed value,
 * described by the schema it was parsed with.
 *
 * The defs here are written as `WorkflowDef` object literals wherever a body has
 * to DISAGREE with its schema, which `workflow()` correctly refuses to compile —
 * that refusal is the type-level test's subject (`sdk/workflow-types.test-d.ts`),
 * and what is left for a runtime spec is the value that arrives anyway, from a
 * body no compiler checked: a user project the bundler type-checks separately, a
 * `JSON.parse`, a provider's reply.
 */

import { workflow } from "@alexkroman1/aai";
import type { WorkflowDef } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { makeLogger, silentLogger } from "./_test-utils.ts";
import type { Logger } from "./runtime-config.ts";
import { createWorkflowClient, type WdkAdapter } from "./workflow-client.ts";
import { createWorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { createMemoryKeyStore } from "./workflow-keys.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/**
 * An engine over a memory journal, with the defs handed in whole.
 *
 * `_workflow-engine-harness.ts` builds its defs from bodies alone, which is
 * exactly what these specs cannot use: the DECLARATION is the subject here. The
 * replay post-condition that harness registers is a property of the journal and
 * is unaffected by a schema, so nothing is given up by not going through it.
 */
function engineFor(workflows: Record<string, WorkflowDef>, logger: Logger = silentLogger) {
  const journal = createMemoryJournal();
  let n = 0;
  const engine = createWorkflowEngine({
    workflows,
    journal,
    streams: createMemoryStreams(),
    dispatch: vi.fn(),
    newRunId: () => `wrun_${++n}`,
    logger,
  });
  return { engine, journal };
}

describe("a run whose workflow declares an output schema", () => {
  test("completes with the PARSED value, not the body's return", async () => {
    // A `.default()` fills in and an undeclared key is stripped, so what a
    // caller reads back is what the declaration describes — the same rule
    // `start()` already applies to a run's input.
    const digest: WorkflowDef = {
      output: z.object({ headline: z.string(), words: z.number().default(0) }),
      run: () => ({ headline: "otters", extra: "dropped" }),
    };
    const { engine } = engineFor({ digest });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ headline: "otters", words: 0 });
  });

  test("FAILS the run when the body returns what the schema denies", async () => {
    // The alternative is a snapshot reporting `completed` while carrying an
    // output the workflow's own declaration says is impossible — and every
    // reader downstream, `useWorkflowRun<R>` included, is typed against that
    // declaration.
    const digest: WorkflowDef = {
      output: z.object({ headline: z.string() }),
      run: () => ({ headline: 42 }),
    };
    const logger = makeLogger();
    const { engine } = engineFor({ digest }, logger);
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("failed");
    expect(await engine.getRun(runId)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining('Workflow "digest" returned an output') },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Workflow output rejected by its declared schema",
      expect.objectContaining({ runId, workflow: "digest" }),
    );
  });

  test("fails the run when the VALIDATOR itself throws", async () => {
    // A fact about the DECLARATION, identical on every delivery — so letting it
    // propagate would have the queue redeliver a run whose body already
    // completed until the abandonment budget ran out.
    const digest: WorkflowDef = {
      output: {
        "~standard": {
          version: 1,
          vendor: "explodes",
          validate: () => {
            throw new Error("schema is broken");
          },
        },
      },
      run: () => ({ ok: true }),
    };
    const { engine } = engineFor({ digest });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("failed");
    expect(await engine.getRun(runId)).toMatchObject({
      error: { message: expect.stringContaining("schema is broken") },
    });
  });

  test("a JOURNAL failure is still not a failure of the RUN", async () => {
    // The rule this validation had to be placed around: the check runs BEFORE
    // the write and touches no store, so a database blip is a rejected DELIVERY
    // the queue retries — never a run recorded as failed carrying a validation
    // message it never earned.
    const digest = workflow({
      output: z.object({ headline: z.string() }),
      run: () => ({ headline: "otters" }),
    });
    const { engine, journal } = engineFor({ digest });
    const runId = await engine.start("digest", [{}]);
    vi.spyOn(journal, "setStatus").mockImplementation(async (_runId, next) => {
      if (next !== "running") throw new Error("connection reset");
      return true;
    });
    await expect(engine.execute(runId)).rejects.toThrow("connection reset");
  });

  test("a workflow declaring no output completes exactly as before", async () => {
    const bare = workflow({ run: () => ({ anything: ["at", "all"] }) });
    const { engine } = engineFor({ bare });
    const runId = await engine.start("bare", [{}]);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ anything: ["at", "all"] });
  });
});

describe("serving the output schema in the listing", () => {
  /** Every adapter method, because `listing()` calls none of them and a cast would say less. */
  function stubAdapter(): WdkAdapter {
    return {
      start: vi.fn(async () => "wrun_1"),
      getRun: vi.fn(async () => undefined),
      listRuns: vi.fn(async () => []),
      cancel: vi.fn(async () => false),
      wakeUp: vi.fn(async () => 0),
      signal: vi.fn(async () => false),
      readStream: vi.fn(() => new ReadableStream<unknown>({ start: (c) => c.close() })),
      streamTail: vi.fn(async () => -1),
      readOutput: vi.fn(async () => undefined),
    };
  }

  function listingOf(workflows: Record<string, WorkflowDef>) {
    const logger = makeLogger();
    const client = createWorkflowClient({
      workflows,
      keys: createMemoryKeyStore(),
      wdk: stubAdapter(),
      logger,
    });
    return { listing: client.listing(), logger };
  }

  test("converts the declared output schema for the browser", () => {
    const digest = workflow({
      input: z.object({ topic: z.string() }),
      output: z.object({ headline: z.string() }),
      run: () => ({ headline: "a" }),
    });
    const { listing } = listingOf({ digest });
    expect(listing[0]?.outputSchema).toMatchObject({
      type: "object",
      properties: { headline: { type: "string" } },
    });
  });

  test("a `.default()` field is REQUIRED in the served output schema", () => {
    // The mirror image of the input rule, and why the direction is a parameter
    // rather than a constant: what a caller may OMIT when starting a run is not
    // what a completed run PRODUCES. The engine journals the parsed value, so a
    // defaulted field is always there to render.
    const digest = workflow({
      output: z.object({ headline: z.string(), words: z.number().default(0) }),
      run: () => ({ headline: "a", words: 1 }),
    });
    const { listing } = listingOf({ digest });
    expect(listing[0]?.outputSchema).toMatchObject({ required: ["headline", "words"] });
  });

  test("omits it for a workflow that declares none", () => {
    const bare = workflow({ run: () => ({ ok: true }) });
    const { listing } = listingOf({ bare });
    expect(listing).toEqual([{ name: "bare" }]);
  });

  test("an unconvertible output schema warns rather than taking the listing down", () => {
    // Same decision as the input half: the listing also feeds `workflow_status`,
    // so a schema no converter recognises must not make the status tool
    // unusable. A REAL Standard Schema that validates and cannot convert.
    const digest: WorkflowDef = {
      output: {
        "~standard": {
          version: 1,
          vendor: "no-json-schema",
          validate: (value: unknown) => ({ value }),
        },
      },
      run: () => ({ ok: true }),
    };
    const { listing, logger } = listingOf({ digest });
    expect(listing[0]?.outputSchema).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Workflow output schema could not be converted to JSON Schema",
      expect.objectContaining({ workflow: "digest" }),
    );
  });
});
