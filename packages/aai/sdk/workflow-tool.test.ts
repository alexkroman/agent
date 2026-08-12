// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createToolContext } from "./testing.ts";
import type { WorkflowClient } from "./workflow.ts";
import { rejectingWorkflows, workflow } from "./workflow.ts";
import { startTool } from "./workflow-tool.ts";

const digest = workflow({
  input: z.object({ topic: z.string() }),
  run: ({ topic }) => ({ topic }),
});

/** A client recording `start`, over the rejecting base so nothing else is reachable. */
function recordingWorkflows(): WorkflowClient & {
  started: { workflow: unknown; input: unknown; key: string | undefined }[];
} {
  const started: { workflow: unknown; input: unknown; key: string | undefined }[] = [];
  return {
    ...rejectingWorkflows("startTool must not call this"),
    started,
    start: ((wf: unknown, input: unknown, options?: { key?: string }) => {
      started.push({ workflow: wf, input, key: options?.key });
      return Promise.resolve(`run-${started.length}`);
    }) as WorkflowClient["start"],
  };
}

describe("startTool", () => {
  test("takes the workflow's own schema as the tool's inputSchema", () => {
    // Not restated: an author writing this tool by hand either duplicates the
    // schema or widens it and loses the validation `start` would do anyway.
    expect(startTool(digest, { description: "d" }).inputSchema).toBe(digest.input);
  });

  test("leaves inputSchema absent for a workflow that declares none", () => {
    // An empty object schema would read to the LLM as "takes no arguments",
    // which is a different claim from "takes anything".
    const bare = workflow({ run: () => 1 });
    expect(startTool(bare, { description: "d" })).not.toHaveProperty("inputSchema");
  });

  test("keys the run to the session by default", async () => {
    const workflows = recordingWorkflows();
    const ctx = createToolContext({ workflows, sessionId: "session-9" });

    await startTool(digest, { description: "d" }).execute({ topic: "ai" }, ctx);

    // The whole reason this helper exists: `workflow_status` can only report a
    // run that carries a key, and forgetting one fails silently — the run works
    // and the follow-up question becomes unanswerable.
    expect(workflows.started).toEqual([
      { workflow: digest, input: { topic: "ai" }, key: "session-9" },
    ]);
  });

  test("passes the workflow itself, not its name", async () => {
    const workflows = recordingWorkflows();
    await startTool(digest, { description: "d" }).execute(
      { topic: "ai" },
      createToolContext({ workflows }),
    );

    // So a rename cannot desynchronize the tool from the workflow it starts.
    expect(workflows.started[0]?.workflow).toBe(digest);
  });

  test("honours a custom key, for a run that outlives the session", async () => {
    const workflows = recordingWorkflows();
    const ctx = createToolContext({ workflows, sessionId: "session-9" });

    await startTool(digest, {
      description: "d",
      key: () => "account-42",
    }).execute({ topic: "ai" }, ctx);

    expect(workflows.started[0]?.key).toBe("account-42");
  });

  test("answers with the run id and a started marker by default", async () => {
    const workflows = recordingWorkflows();
    const result = await startTool(digest, { description: "d" }).execute(
      { topic: "ai" },
      createToolContext({ workflows }),
    );

    // Deliberately not a sentence: the model composes the reply, and a canned one
    // competes with the system prompt's voice instead of informing it.
    expect(result).toEqual({ runId: "run-1", status: "started" });
  });

  test("honours a custom reply, which receives the run id", async () => {
    const workflows = recordingWorkflows();
    const reply = vi.fn((runId: string) => `working on it (${runId})`);

    const result = await startTool(digest, { description: "d", reply }).execute(
      { topic: "ai" },
      createToolContext({ workflows }),
    );

    expect(reply).toHaveBeenCalledWith("run-1");
    expect(result).toBe("working on it (run-1)");
  });

  test("carries the description through to the LLM", () => {
    expect(startTool(digest, { description: "Start research" }).description).toBe("Start research");
  });
});
