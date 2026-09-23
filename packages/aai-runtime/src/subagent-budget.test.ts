// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for what a `ctx.delegate` run costs the delegating session — split
 * from `subagent.test.ts`, which covers the run itself.
 */

import { subagent, tool } from "@alexkroman1/aai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScriptedOneShotModel,
  registerFakeProviders,
  type ScriptedTurn,
} from "./_pipeline-test-fakes.ts";
import { makeUsageMeter } from "./_test-utils.ts";
import { createSubagentRunner } from "./subagent.ts";
import type { ToolCallDefaults } from "./tool-executor.ts";

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

function setup(script: readonly ScriptedTurn[]) {
  const model = createScriptedOneShotModel(script);
  const fakes = registerFakeProviders({ llm: model });
  unregister = fakes.unregister;
  if (!fakes.llm) throw new Error("fake llm descriptor missing");
  return { model, descriptor: fakes.llm, env: fakes.env };
}

/** Silent, so a forced-final-answer log line does not print through the run. */
const noop = (): void => undefined;
const silent = { debug: noop, info: noop, warn: noop, error: noop };

/** The bag a tool call carries, as a parent tool's context would hand it over. */
function parentCall(overrides: Partial<ToolCallDefaults> = {}): ToolCallDefaults {
  return {
    env: { TENANT_KEY: "tenant-value" },
    sessionId: "session-1",
    logger: silent,
    ...overrides,
  };
}

/**
 * What a delegated run costs the SESSION that delegated.
 *
 * The gap these close is the one that stopped two templates adopting
 * `usageLimits` at all: a subagent run is a full nested tool loop — the most
 * expensive thing a delegating agent does — and none of it reached the meter,
 * so `usage.updated` under-reported and a budget bounded only the conversation.
 * They drive the real runner over a fake that really reports tokens, because a
 * spec that recorded into the meter itself would pass against either wiring.
 * The scripted fake spends two tokens per `doGenerate`, i.e. per STEP.
 */
describe("createSubagentRunner — the delegating session's budget", () => {
  it("reports EVERY step of the run, not one lump per delegation", async () => {
    // Two steps: a tool call, then the answer. A per-attempt report would say
    // one, and a fan-out's cost would then be understated by its own depth.
    const { descriptor, env } = setup([
      { call: { name: "lookup", input: { term: "tide" } } },
      { text: "The tide is out." },
    ]);
    const lookup = tool({
      description: "Look a term up",
      inputSchema: z.object({ term: z.string() }),
      execute: () => "out",
    });
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const { meter: usage, updates } = makeUsageMeter();

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Research.", tools: { lookup } }),
      { task: "Is the tide in?" },
      parentCall({ usage }),
    );

    expect(result.steps).toBe(2);
    expect(usage.snapshot()).toEqual({ inputTokens: 2, outputTokens: 2, totalTokens: 4, steps: 2 });
    // Announced per step, which is what makes `usage.updated` usable as a
    // progress signal on a delegation that takes a while.
    expect(updates).toHaveLength(2);
  });

  it("refuses a delegation once the budget is spent, without dialling the model", async () => {
    const { model, descriptor, env } = setup([{ text: "never asked" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const { meter: usage } = makeUsageMeter({ totalTokens: 100 });
    usage.record({ inputTokens: 90, outputTokens: 30 });

    await expect(
      run(
        subagent({ name: "researcher", systemPrompt: "Research." }),
        { task: "Is the tide in?" },
        parentCall({ usage }),
      ),
    ).rejects.toThrow(/usageLimits\.totalTokens/);
    expect(model.calls).toHaveLength(0);
  });

  it("refuses a REVISION too — a guardrail retry is another full run", async () => {
    // The cap is reached by the first attempt. A check placed above the retry
    // loop would let the guardrail spend the whole revision budget past it.
    const { model, descriptor, env } = setup([{ text: "first" }, { text: "second" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const { meter: usage } = makeUsageMeter({ totalTokens: 2 });

    await expect(
      run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          maxRevisions: 3,
          guardrail: () => "try again",
        }),
        { task: "x" },
        parentCall({ usage }),
      ),
    ).rejects.toThrow(/usageLimits\.totalTokens/);
    expect(model.calls).toHaveLength(1);
  });

  it("a sessionless parent (a workflow step) is uncounted, never refused", async () => {
    // `stepDelegate` hands over a bag with no meter — a durable run does not
    // belong to a session's budget, and absent must not read as exhausted.
    const { descriptor, env } = setup([{ text: "done" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Research." }),
      { task: "x" },
      { env: {}, logger: silent },
    );

    expect(result.text).toBe("done");
  });
});
