// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool behaviour for the transcription-desk template.
 *
 * The tools are the seam between a turn and a run that outlives it, and the
 * thing a template has to get right is what the caller is TOLD: a job id they
 * can write down, an honest "still going", a named failure. The workflow body's
 * own semantics (replay, per-step retry, durable sleep) belong to the engine and
 * are covered in `packages/aai/host/workflow-engine.test.ts`.
 */

import type { Db, ToolDef, WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";

/** A `Db` that answers `select` from a fixed row set and swallows DDL/inserts. */
function makeDb(rows: Record<string, unknown>[] = []): Db {
  return {
    // `Db.query` is generic over the CALLER's row type while this fake knows its
    // own, so the narrowing happens once here rather than at every call site.
    query: <T>(sql: string): Promise<T[]> =>
      Promise.resolve((sql.startsWith("select") ? rows : []) as T[]),
  };
}

/**
 * A `ctx.workflows` a spec fills in as needed. `createToolContext`'s default
 * rejects both methods — right for a tool that should never start a run, which
 * is why every spec here overrides the half it exercises.
 */
function workflowsStub(overrides: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    start: () => Promise.resolve("run-1"),
    get: () => Promise.resolve(undefined),
    ...overrides,
  };
}

function toolNamed(name: string): ToolDef {
  const tool = agentDef.tools[name];
  if (!tool) throw new Error(`template declares no tool "${name}"`);
  return tool;
}

/** A completed-run snapshot with the shape the workflow really returns. */
function snapshot(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "run-42",
    workflow: "transcribe",
    status: "running",
    stepsCompleted: 7,
    ...overrides,
  };
}

describe("the agent definition", () => {
  test("declares the transcribe workflow the tools start", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["transcribe"]);
  });

  test("declares the key the workflow reads, so a missing one fails at deploy", () => {
    // The workflow reads ctx.env.ASSEMBLYAI_API_KEY directly rather than through
    // a provider descriptor, so nothing derives this requirement for it.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });
});

describe("submit_recording", () => {
  test("starts the workflow with the caller's url and label", async () => {
    const start = vi.fn(() => Promise.resolve("run-42"));
    const ctx = createToolContext({ workflows: workflowsStub({ start }) });

    const result = await toolNamed("submit_recording").execute(
      { audioUrl: "https://example.com/call.mp3", label: "tuesday standup" },
      ctx,
    );

    expect(start).toHaveBeenCalledWith("transcribe", {
      audioUrl: "https://example.com/call.mp3",
      label: "tuesday standup",
    });
    expect(result).toEqual({ runId: "run-42", status: "processing" });
  });

  test("omits an absent label rather than passing undefined through", async () => {
    // `exactOptionalPropertyTypes` aside, the workflow's schema defaults `label`
    // — which only happens if the key is ABSENT, not present-and-undefined.
    const start = vi.fn(() => Promise.resolve("run-42"));
    const ctx = createToolContext({ workflows: workflowsStub({ start }) });

    await toolNamed("submit_recording").execute({ audioUrl: "https://e.com/a.mp3" }, ctx);

    expect(start).toHaveBeenCalledWith("transcribe", { audioUrl: "https://e.com/a.mp3" });
  });

  test("answers the turn without waiting for the transcription", async () => {
    const ctx = createToolContext({ workflows: workflowsStub() });
    await expect(
      toolNamed("submit_recording").execute({ audioUrl: "https://e.com/a.mp3" }, ctx),
    ).resolves.toMatchObject({ status: "processing" });
  });
});

describe("check_job", () => {
  test("reports the result once the run has completed", async () => {
    const output = { jobId: "t-1", label: "standup", words: 812 };
    const ctx = createToolContext({
      workflows: workflowsStub({
        get: () => Promise.resolve(snapshot({ status: "completed", output })),
      }),
    });

    const result = await toolNamed("check_job").execute({ runId: "run-42" }, ctx);

    expect(result).toEqual({ status: "done", result: output });
  });

  test("reports progress while the job is still polling", async () => {
    const ctx = createToolContext({
      workflows: workflowsStub({
        get: () => Promise.resolve(snapshot({ status: "sleeping", stepsCompleted: 9 })),
      }),
    });

    const result = await toolNamed("check_job").execute({ runId: "run-42" }, ctx);

    // Honest progress: the poll count rises while the job waits, and the tool
    // reports it rather than inventing a percentage.
    expect(result).toEqual({ status: "sleeping", stepsCompleted: 9 });
  });

  test("surfaces the reason a run failed", async () => {
    const ctx = createToolContext({
      workflows: workflowsStub({
        get: () =>
          Promise.resolve(
            snapshot({ status: "failed", error: "transcription t-1 failed: unsupported codec" }),
          ),
      }),
    });

    const result = await toolNamed("check_job").execute({ runId: "run-42" }, ctx);

    expect(result).toEqual({
      status: "failed",
      reason: "transcription t-1 failed: unsupported codec",
    });
  });

  test("names the id rather than crashing on an unknown run", async () => {
    const ctx = createToolContext({ workflows: workflowsStub() });
    const result = await toolNamed("check_job").execute({ runId: "nope" }, ctx);
    expect(result).toEqual({ error: "No job with id nope" });
  });
});

describe("list_transcripts", () => {
  test("returns the most recent finished transcripts", async () => {
    const rows = [{ job_id: "t-1", label: "standup", summary: "They discussed the migration." }];
    const ctx = createToolContext({ db: makeDb(rows) });

    const result = await toolNamed("list_transcripts").execute({}, ctx);

    expect(result).toEqual({ transcripts: rows });
  });

  test("says so when nothing has finished yet", async () => {
    const ctx = createToolContext({ db: makeDb([]) });
    const result = await toolNamed("list_transcripts").execute({}, ctx);
    expect(result).toEqual({ message: "Nothing processed yet." });
  });
});
