// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool behaviour for the nightly-digest template.
 *
 * The tools are the interesting half to test here: each one is a thin seam onto
 * `ctx.workflows` or `ctx.db`, and the failure mode a template has to get right
 * is the one where the caller is told nothing useful — a missing run reported as
 * a crash, a topic with no digest reported as an empty answer. The workflow
 * body's own semantics (replay, retry, durable sleep) belong to the engine and
 * are covered in `packages/aai/host/workflow-engine.test.ts`.
 */

import type { Db, ToolDef, WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";

/** A `Db` that answers `select` from a fixed row set and swallows DDL/inserts. */
function makeDb(rows: Array<{ topic: string; body: string }> = []): Db {
  return {
    // `Db.query` is generic over the CALLER's row type while this fake knows its
    // own, so the narrowing happens once here rather than at every call site.
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> =>
      Promise.resolve(
        (sql.startsWith("select") ? rows.filter((r) => r.topic === params?.[0]) : []) as T[],
      ),
  };
}

/**
 * A `ctx.workflows` whose two methods a spec supplies as needed.
 *
 * `createToolContext`'s default rejects both — right for a tool that should
 * never start a run, and the thing under test here, so every spec overrides the
 * half it exercises.
 */
function workflowsStub(overrides: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    start: () => Promise.resolve("run-1"),
    get: () => Promise.resolve(undefined),
    ...overrides,
  };
}

/** The tool under test, by name — templates keep their tools on the agent def. */
function toolNamed(name: string): ToolDef {
  const tool = agentDef.tools[name];
  if (!tool) throw new Error(`template declares no tool "${name}"`);
  return tool;
}

describe("the agent definition", () => {
  test("declares the digest workflow the tools start", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["digest"]);
  });
});

describe("start_digest", () => {
  test("starts the declared workflow and returns the run id", async () => {
    const start = vi.fn(() => Promise.resolve("run-42"));
    const ctx = createToolContext({ workflows: workflowsStub({ start }) });

    const result = await toolNamed("start_digest").execute({ topic: "otter behaviour" }, ctx);

    expect(start).toHaveBeenCalledWith("digest", { topic: "otter behaviour" });
    expect(result).toEqual({ runId: "run-42", status: "started" });
  });

  test("does not wait for the run to finish", async () => {
    // The whole point of the seam: `start` resolving is the tool's answer, so a
    // run that never completes must not stall the turn.
    const ctx = createToolContext({ workflows: workflowsStub() });
    await expect(toolNamed("start_digest").execute({ topic: "t" }, ctx)).resolves.toMatchObject({
      status: "started",
    });
  });
});

describe("check_digest", () => {
  test("reports status and progress for a live run", async () => {
    const snapshot: WorkflowRunSnapshot = {
      runId: "run-42",
      workflow: "digest",
      status: "sleeping",
      stepsCompleted: 2,
      wakeAt: 1_700_000_000_000,
    };
    const ctx = createToolContext({
      workflows: workflowsStub({ get: () => Promise.resolve(snapshot) }),
    });

    const result = await toolNamed("check_digest").execute({ runId: "run-42" }, ctx);

    expect(result).toEqual({ status: "sleeping", stepsCompleted: 2, error: undefined });
  });

  test("names the id rather than crashing on an unknown run", async () => {
    const ctx = createToolContext({ workflows: workflowsStub() });
    const result = await toolNamed("check_digest").execute({ runId: "nope" }, ctx);
    expect(result).toEqual({ error: "No run with id nope" });
  });

  test("surfaces a failed run's error to the caller", async () => {
    const ctx = createToolContext({
      workflows: workflowsStub({
        get: () =>
          Promise.resolve({
            runId: "run-42",
            workflow: "digest",
            status: "failed",
            stepsCompleted: 1,
            error: "provider refused",
          }),
      }),
    });

    const result = await toolNamed("check_digest").execute({ runId: "run-42" }, ctx);

    expect(result).toMatchObject({ status: "failed", error: "provider refused" });
  });
});

describe("read_digest", () => {
  test("returns the stored digest for a topic", async () => {
    const rows = [{ topic: "otters", body: "Otters are social." }];
    const ctx = createToolContext({ db: makeDb(rows) });

    const result = await toolNamed("read_digest").execute({ topic: "otters" }, ctx);

    expect(result).toEqual({ topic: "otters", body: "Otters are social." });
  });

  test("says so when nothing has been written up yet", async () => {
    const ctx = createToolContext({ db: makeDb([]) });
    const result = await toolNamed("read_digest").execute({ topic: "otters" }, ctx);
    expect(result).toEqual({ error: "Nothing written up for otters yet" });
  });
});
