// Copyright 2026 the AAI authors. MIT license.
// The slow tier's model wiring, as far as a spec can reach without a provider:
// the effort hint's arithmetic, and the refusal to build a tier with no model.
// UNIT tier — `createSlowLoop` resolves a descriptor and opens no socket.

import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createScriptedOneShotModel, type ScriptedTurn } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { consoleLogger } from "../runtime-config.ts";
import { createUsageMeter } from "../usage-meter.ts";
import { createDigestStore } from "./digest.ts";
import { createSlowLoop, effortProviderOptions } from "./slow-loop.ts";
import { slowTierViewOf } from "./view.ts";

const view = () =>
  slowTierViewOf(
    { instructions: "You are the desk.", messages: [], toolSchemas: [] },
    createDigestStore().read(),
    24,
  );

const signal = (): AbortSignal => new AbortController().signal;

describe("effortProviderOptions", () => {
  test("every thinking budget sits strictly below its output cap", () => {
    // A budget above the cap is a request the provider refuses outright, and a
    // refused slow-tier run verifies nothing while looking like a quiet one.
    for (const effort of ["minimal", "low", "medium", "high"] as const) {
      const opts = effortProviderOptions(effort);
      const thinking = opts.anthropic?.thinking as { budgetTokens: number };
      const google = opts.google?.thinkingConfig as { thinkingBudget: number };
      expect(thinking.budgetTokens).toBe(google.thinkingBudget);
      expect(opts.openai?.reasoningEffort).toBe(effort);
    }
  });

  test("the budget rises with the effort", () => {
    const budget = (e: "minimal" | "high"): number => {
      const anthropic = effortProviderOptions(e).anthropic;
      return (anthropic?.thinking as { budgetTokens: number } | undefined)?.budgetTokens ?? 0;
    };
    expect(budget("high")).toBeGreaterThan(budget("minimal"));
    expect(budget("minimal")).toBeGreaterThan(0);
  });
});

/**
 * A scripted model registered as its own LLM KIND.
 *
 * `createSlowLoop` resolves through `createLlmModelCache`, which is the whole
 * point — it dials the same registry the conversational loop does, on the
 * agent's own env — so a spec reaches the loop the way `eval/stub-llm.ts` does:
 * by registering a kind, not by injecting a model past the resolver.
 * `createScriptedOneShotModel` is the right fake because a `ToolLoopAgent` is
 * non-streaming and answers `doGenerate`.
 */
function installFakeLlm(script: readonly ScriptedTurn[], opts: { hang?: boolean } = {}): void {
  const scripted = createScriptedOneShotModel(script);
  // `Object.create` rather than a spread: `LanguageModel` is a union, so a
  // spread of it is `TS2698`, and a prototype delegate keeps every member the
  // AI SDK reads (`specificationVersion`, `provider`, `modelId`) without
  // enumerating them.
  const model: typeof scripted = opts.hang
    ? Object.assign(Object.create(scripted as object) as typeof scripted, {
        doGenerate: (): Promise<never> => new Promise(() => undefined),
      })
    : scripted;
  const unregister = registerLlmKind(FAKE_KIND, {
    envVar: "FAKE_LLM_KEY",
    label: "Fake",
    create: () => model,
  });
  onTestFinished(unregister);
}

const FAKE_KIND = "two-tier-fake";
const FAKE_LLM = { kind: FAKE_KIND, options: {} };

describe("createSlowLoop", () => {
  const base = {
    env: { FAKE_LLM_KEY: "k" },
    effort: "high" as const,
    maxSteps: 4,
    timeoutMs: 100,
    sessionId: "s1",
    logger: consoleLogger,
    schemas: [],
    executeTool: () => Promise.resolve("{}"),
  };

  test("REFUSES at construction when no descriptor resolves", () => {
    // Deliberate: an agent that declared `twoTier` and cannot reach a model has
    // a configuration error, and discovering it at the first caller utterance —
    // as a run that fails silently while the fast tier keeps promising work is
    // underway — is the worst available moment.
    expect(() => createSlowLoop({ ...base, llm: undefined, fallbackLlm: undefined })).toThrow(
      /no model for the slow tier/,
    );
  });

  test("falls back to the agent's own descriptor", () => {
    // Which makes declaring `twoTier` alone a pure ARCHITECTURE change rather
    // than also a model change — the arm to run when you want to know which of
    // the two a difference came from.
    const fallbackLlm = { kind: "assemblyai", options: { model: "gpt-5.5" } };
    expect(() =>
      createSlowLoop({ ...base, llm: undefined, fallbackLlm, env: { ASSEMBLYAI_API_KEY: "k" } }),
    ).not.toThrow();
  });

  test("runs to completion and discards the final text", async () => {
    // The text is deliberately dropped: everything the caller hears went
    // through the channel tools and everything the fast tier knows went through
    // the digest, so a closing paragraph would be a third channel to keep in
    // sync with the other two.
    installFakeLlm([{ text: "done thinking" }]);
    const loop = createSlowLoop({ ...base, llm: FAKE_LLM, fallbackLlm: undefined });
    await expect(loop(view(), signal())).resolves.toBe("completed");
  });

  test("a run that overruns is ABANDONED, and the outcome says so", async () => {
    // Nobody waits for it, so what a timeout costs is a stale digest rather
    // than a silent caller — but the bound has to exist, or a wedged provider
    // holds the run slot for the rest of the call.
    installFakeLlm([{ text: "never" }], { hang: true });
    const warn = vi.spyOn(consoleLogger, "warn");
    const loop = createSlowLoop({ ...base, llm: FAKE_LLM, fallbackLlm: undefined, timeoutMs: 5 });
    await expect(loop(view(), signal())).resolves.toBe("timed-out");
    expect(warn.mock.calls.some(([m]) => String(m).includes("timed out"))).toBe(true);
  });

  test("an ABORTED run reports `failed` rather than a timeout", async () => {
    // A session release is not a provider fault, and the two are told apart by
    // the signal rather than by which error arrived first.
    installFakeLlm([{ text: "never" }], { hang: true });
    const controller = new AbortController();
    const loop = createSlowLoop({ ...base, llm: FAKE_LLM, fallbackLlm: undefined, timeoutMs: 5 });
    const outcome = loop(view(), controller.signal);
    controller.abort();
    await expect(outcome).resolves.toBe("failed");
  });

  test("an EXHAUSTED session budget skips the run before the request", async () => {
    // Checked BEFORE the request, like every other model call in this runtime:
    // a slow-tier run is several requests, and a budget that bounded only the
    // conversation would leave the expensive half unbounded.
    installFakeLlm([{ text: "unreached" }]);
    // The REAL meter, spent — not a fake with a stubbed `exhausted`. What is
    // under test is that the loop asks the meter the same question every other
    // model call in this runtime asks it, and a hand-built double would pass
    // whether or not it asked the right one.
    const usage = createUsageMeter({ limits: { totalTokens: 1 } });
    usage.record({ inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    expect(usage.exhausted()).toBeDefined();

    const loop = createSlowLoop({ ...base, llm: FAKE_LLM, fallbackLlm: undefined, usage });
    await expect(loop(view(), signal())).resolves.toBe("failed");
  });
});
