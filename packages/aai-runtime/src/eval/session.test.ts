// Copyright 2026 the AAI authors. MIT license.
/**
 * The eval session, driven against a SCRIPTED model.
 *
 * A live-key eval is what this module exists to make possible and is the wrong
 * instrument for testing the module itself: the harness's own contract — a
 * `say()` that returns when the reply to THAT utterance ends, a credential gate
 * that names what is missing, a fake pair that is released on every path — is
 * deterministic, and pinning it here is what stops the two harness bugs this
 * module's doc records from coming back as flaky evals.
 */

import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind, requiredProviderEnvVars } from "../providers/resolve.ts";
import { FAKE_SPEECH_API_KEY_ENV } from "./fake-speech.ts";
import { evalCredentials, openEvalSession } from "./session.ts";

const SPEC_LLM_KIND = "eval-spec-llm";
const SPEC_LLM_ENV = "EVAL_SPEC_LLM_KEY";

/** An agent whose LLM is a script, registered exactly like a real provider. */
function scriptedAgent(steps: Parameters<typeof createFakeLanguageModel>[0]) {
  const release = registerLlmKind(SPEC_LLM_KIND, {
    envVar: SPEC_LLM_ENV,
    label: "Eval spec",
    create: () => createFakeLanguageModel(steps),
  });
  return {
    llm: { kind: SPEC_LLM_KIND, options: {} },
    providerEnv: { [SPEC_LLM_ENV]: "spec-key" },
    release,
  };
}

const lookUp = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => `order ${id} shipped`,
});

describe("evalCredentials", () => {
  test("names the key a default-pipeline agent needs, and how to set it", () => {
    const creds = evalCredentials(agent({ name: "Gate" }), {});
    expect(creds.ready).toBe(false);
    expect(creds.missing).toEqual(["ASSEMBLYAI_API_KEY"]);
    expect(creds.reason).toContain("ASSEMBLYAI_API_KEY");
    expect(creds.reason).toContain("aai eval");
  });

  test("is ready when the host env carries the key, and copies only credentials", () => {
    const creds = evalCredentials(agent({ name: "Gate" }), {
      ASSEMBLYAI_API_KEY: "k",
      HOME: "/home/somebody",
    });
    expect(creds.ready).toBe(true);
    expect(creds.missing).toEqual([]);
    expect(creds.reason).toBeUndefined();
    expect(creds.env.ASSEMBLYAI_API_KEY).toBe("k");
    // Only provider-credential names are copied — an eval must not hand the
    // agent whatever else the developer's shell happens to export.
    expect(creds.env.HOME).toBeUndefined();
  });
});

describe("openEvalSession", () => {
  test("refuses an s2s agent rather than evaluating a config nobody deployed", async () => {
    const def = agent({ name: "Realtime", s2s: { kind: "assemblyai", options: {} } });
    await expect(openEvalSession({ agent: def })).rejects.toThrow(/s2s provider/);
  });

  test("releases the fake speech pair when the session cannot start", async () => {
    // No such LLM kind: `createRuntime` throws inside the wrapped section, which
    // is the path that used to orphan a process-global kind pair per attempt.
    await expect(
      openEvalSession({
        agent: agent({ name: "Broken", llm: { kind: "no-such-llm", options: {} } }),
        providerEnv: {},
      }),
    ).rejects.toThrow();
    // Nothing registered survives: the fake env var is reachable from no kind.
    // (The default AssemblyAI key is in this list whatever happens — an agent
    // with an stt and no llm/tts is not a complete pipeline, so the default one
    // is what would run.)
    expect(requiredProviderEnvVars({ stt: { kind: "aai-eval-stt-1" } })).not.toContain(
      FAKE_SPEECH_API_KEY_ENV,
    );
  });

  test("say() returns after the reply to THAT utterance, and records what was said", async () => {
    const { llm, providerEnv, release } = scriptedAgent({
      steps: [[{ type: "text", text: "Sure — what is the order number?" }]],
    });
    const session = await openEvalSession({
      agent: agent({ name: "Order Desk" }),
      llm,
      providerEnv,
    });
    try {
      const turn = await session.say("I want to check an order");
      expect(turn.text).toBe("Sure — what is the order number?");
      expect(turn.completed).toBe(true);
      expect(turn.toolCalls).toEqual([]);
      // The greeting is a real turn and is in the run-wide view — which is why
      // a claim about one reply belongs on the turn.
      expect(session.said()).toHaveLength(2);
    } finally {
      await session.close();
      release();
    }
  });

  test("sayAll drives every line in order and hands back one turn each", async () => {
    const { llm, providerEnv, release } = scriptedAgent({
      steps: [
        [{ type: "text", text: "Sure — what is the order number?" }],
        [{ type: "text", text: "W1234, got it." }],
      ],
    });
    const session = await openEvalSession({
      agent: agent({ name: "Order Desk" }),
      llm,
      providerEnv,
    });
    try {
      const turns = await session.sayAll(["I want to check an order", "W1234"]);
      // One turn per line, in the order they were said — which is what lets a
      // case ask which turn a mechanism fired in rather than pinning an index.
      expect(turns.map((t) => t.text)).toEqual([
        "Sure — what is the order number?",
        "W1234, got it.",
      ]);
      // Sequential: the second utterance is committed only after the first
      // reply ended, so no turn contains the other's events.
      expect(turns[0]?.events).not.toEqual(turns[1]?.events);
    } finally {
      await session.close();
      release();
    }
  });

  test("sayAll over no lines drives nothing and answers no turns", async () => {
    const { llm, providerEnv, release } = scriptedAgent({ steps: [] });
    const session = await openEvalSession({
      agent: agent({ name: "Order Desk" }),
      llm,
      providerEnv,
    });
    try {
      const before = session.events().length;
      expect(await session.sayAll([])).toEqual([]);
      expect(session.events()).toHaveLength(before);
    } finally {
      await session.close();
      release();
    }
  });

  test("records a tool call with its arguments and its result", async () => {
    const { llm, providerEnv, release } = scriptedAgent({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "look_up", input: '{"id":"W1234"}' }],
        [{ type: "text", text: "It shipped yesterday." }],
      ],
    });
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Order Desk" }), { look_up: lookUp }),
      llm,
      providerEnv,
    });
    try {
      const turn = await session.say("where is order W1234");
      expect(turn.toolCalls).toEqual([
        {
          toolCallId: "c1",
          name: "look_up",
          args: { id: "W1234" },
          result: expect.stringContaining("W1234 shipped"),
        },
      ]);
      expect(turn.text).toContain("shipped yesterday");
    } finally {
      await session.close();
      release();
    }
  });
});

describe("a scripted tool call", () => {
  test("drives the real tool executor, so a stub run covers a tool agent", async () => {
    const { installStubLlm } = await import("./stub-llm.ts");
    const stub = installStubLlm([{ tool: "look_up", args: { id: "W1234" } }, "It shipped."]);
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Order Desk" }), { look_up: lookUp }),
      llm: stub.llm,
      providerEnv: stub.env,
    });
    try {
      const turn = await session.say("where is order W1234");
      // The tool really ran: the result is the tool's own, not the script's.
      expect(turn.toolCalls).toEqual([
        {
          toolCallId: "stub-call-1",
          name: "look_up",
          args: { id: "W1234" },
          result: expect.stringContaining("W1234 shipped"),
        },
      ]);
      expect(turn.text).toContain("It shipped.");
    } finally {
      await session.close();
      stub.release();
    }
  });

  test("a script ending on a tool call still ENDS the turn", async () => {
    const { installStubLlm } = await import("./stub-llm.ts");
    // No line after the call: without the appended default the model would be
    // asked for the same tool call until the step budget ran out.
    const stub = installStubLlm([{ tool: "look_up", args: { id: "W1" } }]);
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Order Desk" }), { look_up: lookUp }),
      llm: stub.llm,
      providerEnv: stub.env,
    });
    try {
      const turn = await session.say("where is order W1");
      expect(turn.completed).toBe(true);
      expect(turn.toolCalls).toHaveLength(1);
      expect(turn.text).not.toBe("");
    } finally {
      await session.close();
      stub.release();
    }
  });
});
