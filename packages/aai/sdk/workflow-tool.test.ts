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
  test("takes the workflow's own schema as the tool's input", () => {
    // Not restated: an author writing this tool by hand either duplicates the
    // schema or widens it and loses the validation `start` would do anyway.
    expect(startTool(digest, { description: "d" }).input).toBe(digest.input);
  });

  test("leaves input absent for a workflow that declares none", () => {
    // An empty object schema would read to the LLM as "takes no arguments",
    // which is a different claim from "takes anything".
    const bare = workflow({ run: () => 1 });
    expect(startTool(bare, { description: "d" })).not.toHaveProperty("input");
  });

  test("keys the run to the session by default", async () => {
    const workflows = recordingWorkflows();
    const ctx = createToolContext({ workflows, sessionId: "session-9" });

    await startTool(digest, { description: "d" }).run({ topic: "ai" }, ctx);

    // The whole reason this helper exists: `workflow_status` can only report a
    // run that carries a key, and forgetting one fails silently — the run works
    // and the follow-up question becomes unanswerable.
    expect(workflows.started).toEqual([
      { workflow: digest, input: { topic: "ai" }, key: "session-9" },
    ]);
  });

  test("passes the workflow itself, not its name", async () => {
    const workflows = recordingWorkflows();
    await startTool(digest, { description: "d" }).run(
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
    }).run({ topic: "ai" }, ctx);

    expect(workflows.started[0]?.key).toBe("account-42");
  });

  test("answers with the run id and a started marker by default", async () => {
    const workflows = recordingWorkflows();
    const result = await startTool(digest, { description: "d" }).run(
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

    const result = await startTool(digest, { description: "d", reply }).run(
      { topic: "ai" },
      createToolContext({ workflows }),
    );

    expect(reply).toHaveBeenCalledWith("run-1");
    expect(result).toBe("working on it (run-1)");
  });

  test("carries the description through to the LLM", () => {
    expect(startTool(digest, { description: "Start research" }).description).toBe("Start research");
  });

  describe("a derived input", () => {
    // The run's input is the ONE handoff from session-scoped state to durable
    // work — a workflow cannot read `ctx.state` — so an input assembled from the
    // session has to be built by code. Asking the model for it instead means
    // asking it to retype a structure it is only holding a reference to.
    const brief = z.object({ id: z.string() });

    test("shows the LLM the narrow schema, not the workflow's", () => {
      const asked = startTool(digest, {
        description: "d",
        inputSchema: brief,
        input: ({ id }) => ({ topic: id }),
      });

      expect(asked.input).toBe(brief);
      expect(asked.input).not.toBe(digest.input);
    });

    test("starts the run with the MAPPED input", async () => {
      const workflows = recordingWorkflows();
      const ctx = createToolContext({ workflows, sessionId: "session-4" });

      await startTool(digest, {
        description: "d",
        inputSchema: brief,
        input: ({ id }) => ({ topic: `topic-for-${id}` }),
      }).run({ id: "42" }, ctx);

      // The workflow sees its own shape; the model never typed it.
      expect(workflows.started).toEqual([
        { workflow: digest, input: { topic: "topic-for-42" }, key: "session-4" },
      ]);
    });

    test("hands the mapper the live context, so it can read session state", async () => {
      const workflows = recordingWorkflows();
      const ctx = createToolContext({ workflows, sessionId: "session-7" });
      // The case the overload exists for: the snapshot comes from `ctx`.
      ctx.state.pending = { topic: "from state" };

      await startTool(digest, {
        description: "d",
        inputSchema: brief,
        input: (_args, inner) => (inner.state.pending as { topic: string }) ?? { topic: "none" },
      }).run({ id: "42" }, ctx);

      expect(workflows.started[0]?.input).toEqual({ topic: "from state" });
    });

    test("awaits an async mapper", async () => {
      const workflows = recordingWorkflows();

      await startTool(digest, {
        description: "d",
        inputSchema: brief,
        input: ({ id }) => Promise.resolve({ topic: id }),
      }).run({ id: "async" }, createToolContext({ workflows }));

      // A mapper that reads a database or an API is the ordinary case, so a
      // returned promise must not reach `start()` as the input itself.
      expect(workflows.started[0]?.input).toEqual({ topic: "async" });
    });

    test("refuses a narrow schema with no mapper, at construction", () => {
      // The pairing the type system cannot enforce on one signature (see the note
      // on `startTool`). Unpaired, the tool would hand `start()` arguments its
      // workflow never declared and the run would be rejected at the far end of a
      // tool call — reported to the model as a failure whose cause is the tool
      // definition. Throwing at module load turns that into a build failure.
      // It type-checks, which is exactly why the throw has to exist.
      expect(() => startTool(digest, { description: "d", inputSchema: brief })).toThrow(
        "needs an `input` mapper",
      );
    });

    test("still keys the run to the session", async () => {
      const workflows = recordingWorkflows();

      await startTool(digest, {
        description: "d",
        inputSchema: brief,
        input: ({ id }) => ({ topic: id }),
      }).run({ id: "x" }, createToolContext({ workflows, sessionId: "session-2" }));

      // The default that makes `workflow_status` able to report the run must not
      // depend on which overload was used.
      expect(workflows.started[0]?.key).toBe("session-2");
    });
  });
});
