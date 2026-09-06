// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the runner behind `stepDelegate` — that a step really gets the
 * subagent loop (not a second, thinner one), on the sessionless bag the module
 * doc argues for, with the gateway default a `SubagentDef.llm` overrides.
 *
 * The SLOT is `@alexkroman1/aai`'s (`sdk/step-delegate.test.ts`); the LOOP is
 * `subagent.test.ts` beside this. What this file owns is the binding between
 * them.
 */

import { subagent, tool } from "@alexkroman1/aai";
import { publishStepDelegate } from "@alexkroman1/aai/host-internal";
import { stepDelegate } from "@alexkroman1/aai/step";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createScriptedOneShotModel, registerFakeProviders } from "./_pipeline-test-fakes.ts";
import { createStepDelegate } from "./step-delegate.ts";

const noop = (): void => undefined;
const silent = { debug: noop, info: noop, warn: noop, error: noop };

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
  publishStepDelegate(undefined);
});

/**
 * A fake provider registered under its own kind, plus the env its credential
 * resolves from — the same setup `subagent.test.ts` uses, so what is exercised
 * here is the BINDING rather than a second fake.
 */
function fakes(script: Parameters<typeof createScriptedOneShotModel>[0]) {
  const model = createScriptedOneShotModel(script);
  const registered = registerFakeProviders({ llm: model });
  unregister = registered.unregister;
  if (!registered.llm) throw new Error("fake llm descriptor missing");
  return { model, descriptor: registered.llm, env: registered.env };
}

describe("createStepDelegate", () => {
  it("runs the subagent loop and answers with the same result a tool would get", async () => {
    const { descriptor, env } = fakes([{ text: "Prices fell 12% in 2025." }]);
    const run = createStepDelegate({ env, logger: silent });

    const result = await run(
      // Naming the LLM is what makes this test independent of the gateway
      // default, which no fake registry can resolve.
      subagent({ name: "researcher", systemPrompt: "Research it.", llm: descriptor }),
      { task: "battery prices" },
    );

    expect(result).toEqual({
      text: "Prices fell 12% in 2025.",
      steps: 1,
      toolCalls: [],
      revisions: 0,
      accepted: true,
    });
  });

  it("gives a subagent's tools the agent ENV and a detached, sessionless context", async () => {
    const { descriptor, env } = fakes([
      { call: { name: "lookup", input: { term: "tide" } } },
      { text: "The tide is out." },
    ]);
    const seen: { key: string | undefined; sessionId: string; messages: number }[] = [];
    const lookup = tool({
      description: "Look a term up",
      inputSchema: z.object({ term: z.string() }),
      execute: (_args, ctx) => {
        seen.push({
          key: ctx.env.TENANT_KEY,
          sessionId: ctx.sessionId,
          messages: ctx.messages.length,
        });
        return "ok";
      },
    });
    const run = createStepDelegate({
      env: { ...env, TENANT_KEY: "tenant-value" },
      logger: silent,
    });

    await run(
      subagent({
        name: "researcher",
        systemPrompt: "Look things up.",
        llm: descriptor,
        tools: { lookup },
      }),
      { task: "anything" },
    );

    // The env crosses and there is no conversation — a run is not a session, so
    // there is nothing for a delegated run to have heard.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toBe("tenant-value");
    expect(seen[0]?.messages).toBe(0);
    // The id is MINTED per call rather than empty, and that matters for a fan-out
    // specifically: `remember`/`recall` keep their notes in a process-wide map
    // keyed by session id, so N concurrent `investigate` steps sharing an ""
    // bucket would read each other's notes. `buildToolContext` owns that rule;
    // this pins that a step's delegation is on the right side of it.
    expect(seen[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a DISTINCT session id per delegation, so a fan-out cannot cross notes", async () => {
    const { descriptor, env } = fakes([
      { call: { name: "lookup", input: {} } },
      { text: "one" },
      { call: { name: "lookup", input: {} } },
      { text: "two" },
    ]);
    const ids: string[] = [];
    const lookup = tool({
      description: "Record the id",
      inputSchema: z.object({}),
      execute: (_args, ctx) => {
        ids.push(ctx.sessionId);
        return "ok";
      },
    });
    const run = createStepDelegate({ env, logger: silent });
    const researcher = subagent({
      name: "researcher",
      systemPrompt: "Look things up.",
      llm: descriptor,
      tools: { lookup },
    });

    await run(researcher, { task: "a" });
    await run(researcher, { task: "b" });

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("carries expectedOutput and the per-call context, like every other delegation", async () => {
    const { model, descriptor, env } = fakes([{ text: "done" }]);
    const run = createStepDelegate({ env, logger: silent });

    await run(
      subagent({
        name: "researcher",
        systemPrompt: "Research it.",
        expectedOutput: "One paragraph.",
        llm: descriptor,
      }),
      { task: "x", context: "This angle belongs to a briefing on batteries." },
    );

    const prompt = model.calls[0]?.prompt as { role: string; content: unknown }[];
    const system = JSON.stringify(prompt.find((message) => message.role === "system")?.content);
    expect(system).toContain("## EXPECTED OUTPUT");
    expect(system).toContain("One paragraph.");
    expect(system).toContain("briefing on batteries");
  });

  it("runs a guardrail's revision, so a step's subagent is held to the same bar", async () => {
    const { model, descriptor, env } = fakes([{ text: "thin" }, { text: "Confirmed: yes." }]);
    const run = createStepDelegate({ env, logger: silent });

    const result = await run(
      subagent({
        name: "checker",
        systemPrompt: "Check it.",
        llm: descriptor,
        guardrail: ({ text }) => text.startsWith("Confirmed:") || "Start with 'Confirmed:'.",
      }),
      { task: "x" },
    );

    expect(result).toMatchObject({ text: "Confirmed: yes.", revisions: 1, accepted: true });
    expect(model.calls).toHaveLength(2);
  });

  it("is what `stepDelegate` reaches once published", async () => {
    const { descriptor, env } = fakes([{ text: "from the published runner" }]);
    publishStepDelegate(createStepDelegate({ env, logger: silent }));

    const result = await stepDelegate(
      subagent({ name: "researcher", systemPrompt: "Research it.", llm: descriptor }),
      { task: "x" },
    );

    expect(result.text).toBe("from the published runner");
  });

  it("defaults to the LLM GATEWAY when the subagent names no model", async () => {
    // Not a live call: what is asserted is WHICH credential the default asks
    // for, which is the whole content of the default. An env with no
    // AssemblyAI key fails naming it, where a wrong default would fail naming
    // some other provider — or, worse, resolve one.
    const run = createStepDelegate({ env: {}, logger: silent });
    await expect(
      run(subagent({ name: "researcher", systemPrompt: "Research it." }), { task: "x" }),
    ).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
  });
});
