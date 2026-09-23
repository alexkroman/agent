// Copyright 2026 the AAI authors. MIT license.
/**
 * The simulated caller, with BOTH models scripted.
 *
 * The caller's loop is deterministic apart from the two models, so pinning it
 * against scripts is what keeps its contract — `end_call` ends it, `maxTurns`
 * hangs up for it, the metrics count what the turns hold — from being tested
 * only by a live run that cannot tell a harness bug from a model's choice.
 */

import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { openEvalSession } from "./session.ts";
import { END_CALL_TOOL, simulateCall } from "./simulate.ts";
import { installStubLlm } from "./stub-llm.ts";
import { openEvalTextAgent } from "./text-agent.ts";

let kinds = 0;

/** The AGENT's scripted model, registered like a real provider. */
function scriptedAgentLlm(steps: Parameters<typeof createFakeLanguageModel>[0]) {
  kinds += 1;
  const kind = `simulate-spec-llm-${kinds}`;
  const release = registerLlmKind(kind, {
    envVar: "SIMULATE_SPEC_LLM_KEY",
    label: "Simulate spec",
    create: () => createFakeLanguageModel(steps),
  });
  return {
    llm: { kind, options: { model: "stub" } },
    providerEnv: { SIMULATE_SPEC_LLM_KEY: "k" },
    release,
  };
}

const lookUp = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => `order ${id} shipped`,
});

const caller = {
  persona: "a hurried customer",
  goal: "find out whether order W1234 shipped",
};

describe("simulateCall", () => {
  test("drives the caller's lines until it calls end_call, and says why it ended", async () => {
    const agentLlm = scriptedAgentLlm({
      steps: [
        [{ type: "text", text: "Sure — what is the order number?" }],
        [{ type: "tool-call", toolCallId: "c1", toolName: "look_up", input: '{"id":"W1234"}' }],
        [{ type: "text", text: "It shipped yesterday." }],
      ],
    });
    const callerLlm = installStubLlm([
      "Hi, has my order shipped?",
      "It's W1234.",
      { tool: END_CALL_TOOL, args: { reason: "got my answer" } },
    ]);
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Order Desk" }), { look_up: lookUp }),
      llm: agentLlm.llm,
      providerEnv: agentLlm.providerEnv,
    });
    try {
      const call = await simulateCall(session, {
        caller,
        llm: callerLlm.llm,
        providerEnv: callerLlm.env,
      });
      expect(call.endedBy).toBe("caller");
      expect(call.endReason).toBe("got my answer");
      expect(call.turns.map((t) => t.caller)).toEqual(["Hi, has my order shipped?", "It's W1234."]);
      expect(call.turns[1]?.turn.text).toBe("It shipped yesterday.");
      // The greeting was heard before the caller spoke, and is in the call.
      expect(call.greeting).toHaveLength(1);
      expect(call.metrics.turns).toBe(2);
      expect(call.metrics.toolCallCounts).toEqual({ look_up: 1 });
      expect(call.metrics.toolCalls[0]?.result).toContain("shipped");
      // Every turn produced text, so every turn has a latency reading.
      expect(call.turns.every((t) => typeof t.latencyMs === "number")).toBe(true);
      expect(call.metrics.latencyMs.max).toBeGreaterThanOrEqual(0);
      expect(call.transcript()).toContain("Caller: It's W1234.");
      expect(call.transcript()).toContain("[tool look_up(");
    } finally {
      await session.close();
      callerLlm.release();
      agentLlm.release();
    }
  });

  test("hangs up for a caller that never does, and reports it as max-turns", async () => {
    const agentLlm = scriptedAgentLlm({ steps: [[{ type: "text", text: "Could you repeat?" }]] });
    // Repeats its last line forever: a caller whose goal is never met.
    const callerLlm = installStubLlm(["Hello? Hello?"]);
    const session = await openEvalSession({
      agent: agent({ name: "Order Desk" }),
      llm: agentLlm.llm,
      providerEnv: agentLlm.providerEnv,
    });
    try {
      const call = await simulateCall(session, {
        caller,
        llm: callerLlm.llm,
        providerEnv: callerLlm.env,
        maxTurns: 3,
      });
      expect(call.endedBy).toBe("max-turns");
      expect(call.endReason).toBeUndefined();
      expect(call.turns).toHaveLength(3);
    } finally {
      await session.close();
      callerLlm.release();
      agentLlm.release();
    }
  });

  test("says the scripted opening verbatim, then hands over to the caller model", async () => {
    const agentLlm = scriptedAgentLlm({ steps: [[{ type: "text", text: "Happy to help." }]] });
    const callerLlm = installStubLlm([{ tool: END_CALL_TOOL, args: { reason: "done" } }]);
    const session = await openEvalSession({
      agent: agent({ name: "Order Desk" }),
      llm: agentLlm.llm,
      providerEnv: agentLlm.providerEnv,
    });
    try {
      const call = await simulateCall(session, {
        caller: { ...caller, opening: "Order W1234, please." },
        llm: callerLlm.llm,
        providerEnv: callerLlm.env,
      });
      expect(call.turns.map((t) => t.caller)).toEqual(["Order W1234, please."]);
      expect(call.endedBy).toBe("caller");
    } finally {
      await session.close();
      callerLlm.release();
      agentLlm.release();
    }
  });

  test("drives a TEXT agent through send(), with no greeting in front", async () => {
    const agentLlm = scriptedAgentLlm({ steps: [[{ type: "text", text: "Hello from text." }]] });
    const callerLlm = installStubLlm(["hi", { tool: END_CALL_TOOL }]);
    const textAgent = await openEvalTextAgent({
      agent: agent({ name: "Texty", text: true }),
      llm: agentLlm.llm,
      providerEnv: agentLlm.providerEnv,
    });
    try {
      const call = await simulateCall(textAgent, {
        caller,
        llm: callerLlm.llm,
        providerEnv: callerLlm.env,
      });
      expect(call.greeting).toEqual([]);
      expect(call.turns[0]?.turn.text).toBe("Hello from text.");
      expect(call.endedBy).toBe("caller");
      expect(call.endReason).toBeUndefined();
    } finally {
      await textAgent.close();
      callerLlm.release();
      agentLlm.release();
    }
  });
});
