// Copyright 2026 the AAI authors. MIT license.
/**
 * The TEXT suite's credential gate, and one real suite registered through
 * `describeTextEval`.
 *
 * The gate is the half with a wrong answer available — reporting a key the
 * agent will never read, and skipping a suite this machine could have run — so
 * it is asserted directly. The suite at the bottom is the other half: a
 * template ships this function, and a spec of the gate alone would leave the
 * per-case conversation, the stub install and the `{ live: true }` skip covered
 * only by another package's run.
 *
 * **It is FORCED into stub mode** (`vi.stubEnv` at module scope, which is when
 * `describeTextEval` reads the environment). Without that, this file would
 * drive a LIVE model — in the unit tier, on the key of whoever happens to have
 * one exported.
 */

import { agent, tool } from "@alexkroman1/aai";
import { anthropicLlm } from "@alexkroman1/aai/llm";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { describeTextEval } from "./describe-text.ts";
import { toolNames } from "./events.ts";
import { evalTextCredentials } from "./text-agent.ts";

const def = agent({ name: "Text Mode", text: true });

describe("evalTextCredentials", () => {
  test("asks for the DEFAULTED model's key when the agent declares no llm", () => {
    // `createTextAgent` falls back to `assemblyAILlm()`, so the question is
    // asked about the model the run would really use.
    expect(evalTextCredentials(def, { ASSEMBLYAI_API_KEY: "k" }).ready).toBe(true);
    expect(evalTextCredentials(def, {}).reason).toContain("ASSEMBLYAI_API_KEY");
  });

  test("asks for the LLM's key alone — the voice gate over-asked here", () => {
    // A text agent has no speech stage, so `evalCredentials`' no-complete-
    // pipeline branch reported `ASSEMBLYAI_API_KEY` for this agent and skipped
    // a suite the machine could run.
    const anthropic = agent({
      name: "Text Anthropic",
      text: true,
      llm: anthropicLlm({ model: "claude-opus-5" }),
    });
    expect(evalTextCredentials(anthropic, { ANTHROPIC_API_KEY: "k" })).toMatchObject({
      ready: true,
      missing: [],
    });
    expect(evalTextCredentials(anthropic, { ASSEMBLYAI_API_KEY: "k" }).missing).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });

  test("names the descriptor's own apiKeyEnv, like every other credential read", () => {
    const own = agent({
      name: "Text Own Key",
      text: true,
      llm: anthropicLlm({ model: "claude-opus-5", apiKeyEnv: "MY_KEY" }),
    });
    // The NAME comes off the descriptor. Whether the shell can satisfy it is a
    // different question and the answer is no, here as in `evalCredentials`:
    // `withHostCredentialFallback` copies only the registries' own variables,
    // so a renamed key is supplied through `env`/`providerEnv` rather than
    // exported — which is what a suite for such an agent has to do anyway.
    expect(evalTextCredentials(own, { MY_KEY: "k" }).missing).toEqual(["MY_KEY"]);
    expect(evalTextCredentials(own, {}).missing).toEqual(["MY_KEY"]);
  });
});

// Read by `describeTextEval` below at COLLECTION time, which is why the stub is
// set here rather than in a hook.
vi.stubEnv("AAI_EVAL_STUB", "1");

const echo = tool({
  description: "Echo a line back.",
  inputSchema: z.object({ line: z.string() }),
  execute: async ({ line }) => `echoed: ${line}`,
});

describeTextEval(withTools(agent({ name: "Text Stub Suite", text: true }), { echo }), (test) => {
  test(
    "drives a real text agent against the scripted model",
    async ({ agent: textAgent, mode }) => {
      expect(mode).toBe("stub");
      const turn = await textAgent.send("are you there?");
      // Everything but the model is real: the turn ran through the tool
      // executor and the event stream, and the reply is what `send` saw.
      expect(turn.text).toBe("scripted, and only the model is");
      expect(turn.completed).toBe(true);
      // No greeting turn in text mode, so the first reply is the only one.
      expect(textAgent.said()).toEqual(["scripted, and only the model is"]);
    },
    { stubReply: "scripted, and only the model is" },
  );

  test(
    "a scripted tool call really executes",
    async ({ agent: textAgent }) => {
      const turn = await textAgent.send("echo hello");
      expect(toolNames(turn.toolCalls)).toEqual(["echo"]);
      expect(turn.toolCalls[0]?.result).toBe("echoed: hello");
    },
    { stubReply: [{ tool: "echo", args: { line: "hello" } }, "Done."] },
  );

  test(
    "a live-only case does not run against a script",
    async () => {
      expect.fail("a { live: true } case must be skipped in stub mode");
    },
    { live: true },
  );
});
