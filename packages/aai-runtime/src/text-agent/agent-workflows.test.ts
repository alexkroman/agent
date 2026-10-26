// Copyright 2026 the AAI authors. MIT license.
/**
 * A text agent's tools get a SESSION-SCOPED `ctx.workflows`, as a voice
 * session's do: a start with no key is keyed by the conversation, `"session"`
 * resolves to it, and the `workflow_*` builtins — keyed by `ctx.sessionId` —
 * see what the conversation started.
 */

import { type AgentDef, agent, tool, type WorkflowContext, workflow } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { silentLogger } from "../_logger-test-utils.ts";
import { runTextAgent } from "../testing/run-text-agent.ts";
import { createMemoryJournal } from "../workflow/journal/backends/memory.ts";
import { buildWorkflowClient } from "../workflow/runtime.ts";

/** Parks on `go` for an hour: a run that stays live across the turns below. */
const slow = workflow({
  description: "slow",
  run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
    await ctx.waitForSignal("go", { timeoutMs: 3_600_000 });
    return "done";
  },
});

/** The agent, with the two tools a build would enumerate from its `tools/`. */
const desk: AgentDef = withTools(
  agent({
    name: "Desk",
    mode: "text",
    systemPrompt: "Help.",
    workflows: { slow },
    builtinTools: ["workflow_status"],
  }),
  {
    kick: tool({
      description: "Start the slow job.",
      execute: async (_args, ctx) => ({ runId: await ctx.workflows.start(slow, {}) }),
    }),
    approve: tool({
      description: "Answer the slow job.",
      execute: async (_args, ctx) => ({
        answered: await ctx.workflows.signalRun(slow, "session", "go", { ok: true }),
      }),
    }),
  },
);

/** One turn in session `s1` whose model calls `name` once and then speaks. */
async function turn(workflows: NonNullable<ReturnType<typeof buildWorkflowClient>>, name: string) {
  const run = await runTextAgent(desk, "go", {
    workflows: workflows.client,
    sessionId: "s1",
    script: [{ toolCalls: [{ name }] }, { text: "ok" }],
  });
  const [call] = run.toolCalls;
  return JSON.parse(String(call?.result)) as Record<string, unknown>;
}

describe("ctx.workflows in a text agent", () => {
  test("a tool's start is keyed by the session, so workflow_status and signalRun find it", async () => {
    const built = buildWorkflowClient(
      desk,
      undefined,
      undefined,
      silentLogger,
      createMemoryJournal(),
    );
    if (!built) throw new Error("the agent declares a workflow");
    try {
      const kicked = await turn(built, "kick");
      expect(kicked).toEqual({ runId: expect.stringMatching(/^wrun_/) });
      // Keyed by the conversation, which is what makes it reachable next turn.
      expect(await built.client.find(slow, "s1")).toMatchObject([{ runId: kicked.runId }]);

      const status = await turn(built, "workflow_status");
      expect(status).toMatchObject({ runs: [{ runId: kicked.runId, workflow: "slow" }] });

      // `"session"` resolves to the conversation here too, so the tool that
      // answers the run it started needs no key of its own.
      expect(await turn(built, "approve")).toEqual({ answered: true });
    } finally {
      built.stop();
    }
  });
});
