// Copyright 2026 the AAI authors. MIT license.
/**
 * The mode decision, and one real suite registered through `describeEval`.
 *
 * The decision is the part with a WRONG answer available — silently downgrading
 * a pipeline that asked to measure, or silently spending tokens in one that did
 * not — so it is asserted directly. The suite at the bottom is the other half:
 * `describeEval` is what a template ships, and a spec of the mode alone would
 * leave the per-case session, the stub install and the `{ live: true }` skip
 * covered only by another package's run.
 *
 * **It is FORCED into stub mode** (`vi.stubEnv` at module scope, which is when
 * `describeEval` reads the environment). Without that, this file would drive a
 * LIVE model — in the unit tier, on the key of whoever happens to have one
 * exported.
 */

import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { announceEvalMode, describeEval, resolveEvalMode } from "./describe.ts";
import { toolResultIn } from "./events.ts";
import { installStubLlm, STUB_LLM_API_KEY_ENV } from "./stub-llm.ts";

const def = agent({ name: "Mode" });

describe("resolveEvalMode", () => {
  test("goes live when the agent's credential is there", () => {
    expect(resolveEvalMode(def, { ASSEMBLYAI_API_KEY: "k" })).toEqual({
      mode: "live",
      reason: "a provider credential is set",
    });
  });

  test("falls back to the scripted model with no credential, and says which is missing", () => {
    const { mode, reason } = resolveEvalMode(def, {});
    expect(mode).toBe("stub");
    expect(reason).toContain("ASSEMBLYAI_API_KEY");
  });

  test("AAI_EVAL_STUB wins over a credential, so a pipeline cannot start spending", () => {
    expect(resolveEvalMode(def, { ASSEMBLYAI_API_KEY: "k", AAI_EVAL_STUB: "1" })).toEqual({
      mode: "stub",
      reason: "AAI_EVAL_STUB is set",
    });
  });

  test("AAI_REQUIRE_EVAL turns a missing credential into a failure, not a downgrade", () => {
    expect(() => resolveEvalMode(def, { AAI_REQUIRE_EVAL: "1" })).toThrow(/ASSEMBLYAI_API_KEY/);
  });

  test("an llm OVERRIDE decides the credential question with it", () => {
    // The agent wants Anthropic; the case overrides the model with one this
    // machine has a key for. Reading the mode off the agent alone announced
    // SCRIPTED while holding the key the run would really have used.
    const anthropicAgent = agent({ name: "Override", llm: { kind: "anthropic", options: {} } });
    const env = { ASSEMBLYAI_API_KEY: "k" };
    expect(resolveEvalMode(anthropicAgent, env).mode).toBe("stub");
    expect(
      resolveEvalMode(anthropicAgent, env, { llm: { kind: "assemblyai", options: {} } }).mode,
    ).toBe("live");
  });

  test("an override the machine has no key for still reports stub, naming it", () => {
    const { mode, reason } = resolveEvalMode(
      agent({ name: "Override" }),
      {},
      {
        llm: { kind: "anthropic", options: {} },
      },
    );
    expect(mode).toBe("stub");
    expect(reason).toContain("ANTHROPIC_API_KEY");
  });

  test("AAI_REQUIRE_EVAL is satisfied by a credential", () => {
    expect(resolveEvalMode(def, { AAI_REQUIRE_EVAL: "1", ASSEMBLYAI_API_KEY: "k" }).mode).toBe(
      "live",
    );
  });
});

describe("installStubLlm", () => {
  test("registers a kind that resolves like a provider, with its own credential", () => {
    const stub = installStubLlm("hello");
    try {
      expect(stub.llm.kind).toContain("stub-llm");
      expect(stub.env[STUB_LLM_API_KEY_ENV]).toBeTypeOf("string");
    } finally {
      stub.release();
    }
  });

  test("each install gets its own kind, so two sessions cannot cross-talk", () => {
    const a = installStubLlm("a");
    const b = installStubLlm("b");
    try {
      expect(a.llm.kind).not.toBe(b.llm.kind);
    } finally {
      a.release();
      b.release();
    }
  });
});

describe("announceEvalMode", () => {
  /**
   * The one line that separates a wiring check from a behaviour measurement, and
   * nothing asserted it was emitted at all — which is how it came to be dropped
   * on every GREEN `aai eval` run for as long as it had been there. So the claim
   * is the CHANNEL, not the wording: `console.warn` is intercepted by vitest and
   * handed to whichever reporter it resolved, and the one it picks for an AGENT
   * prints a passing file's captured output nowhere. A direct stderr write is
   * what survives any of them.
   */
  test("writes to stderr rather than through the intercepted console", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);

    announceEvalMode("eval: X — SCRIPTED model (reason).");

    expect(warn).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("eval: X — SCRIPTED model (reason).\n");
  });
});

// Read by `describeEval` below at COLLECTION time, which is why the stub is set
// here rather than in a hook. `unstubEnvs` restores it before each test runs,
// which is fine: the mode was already decided.
vi.stubEnv("AAI_EVAL_STUB", "1");

/** A tool that REASONS with a model — the shape `stubGenerate` exists for. */
const judge = tool({
  description: "Judge a claim.",
  inputSchema: z.object({ claim: z.string() }),
  execute: async ({ claim }, ctx) =>
    (await ctx.generate({ prompt: `judge: ${claim}`, schema: z.object({ verdict: z.string() }) }))
      .object,
});

describeEval(withTools(agent({ name: "Stub Suite" }), { judge }), (test) => {
  test(
    "drives a real session against the scripted model",
    async ({ session, mode }) => {
      expect(mode).toBe("stub");
      const turn = await session.say("are you there?");
      // Everything but the model is real: the reply came back through the
      // pipeline, the session committed it, and the turn is what say() saw.
      expect(turn.text).toBe("scripted, and only the model is");
      expect(turn.completed).toBe(true);
      expect(session.said()).toHaveLength(2); // the greeting, then this reply
    },
    { stubReply: "scripted, and only the model is" },
  );

  test(
    "a live-only case does not run against a script",
    async () => {
      expect.fail("a { live: true } case must be skipped in stub mode");
    },
    { live: true },
  );

  test(
    "a scripted-only case DOES run here — it is the mirror of live",
    async ({ session, mode }) => {
      expect(mode).toBe("stub");
      // The shape this marker exists for: only a script will call a tool the
      // model would decline, so only a script can watch the gate refuse.
      expect((await session.say("go on then")).text).toContain("scripted");
    },
    { scripted: true, stubReply: "scripted, and only the model is" },
  );

  test(
    "a SCHEMA generate call answers too — the shape `ai` reads, not the v3 string",
    async ({ session }) => {
      // The half that was broken while plain text worked: `ctx.generate({ schema })`
      // is `generateText` + `Output.object`, and `generateText` reads
      // `finishReason.unified`. With the bare string the output branch never ran
      // and a grader-shaped tool got `{"error":"No output generated."}`.
      const { createGenerateFn } = await import("../generate.ts");
      const release = registerLlmKind("eval-spec-schema", {
        envVar: "EVAL_SPEC_SCHEMA_KEY",
        label: "Spec schema",
        create: () =>
          createFakeLanguageModel({
            script: [{ type: "text", text: '{"grounded":true,"score":7}' }],
          }),
      });
      try {
        const generate = createGenerateFn({
          llm: { kind: "eval-spec-schema", options: {} },
          env: { EVAL_SPEC_SCHEMA_KEY: "k" },
        });
        const answer = await generate({
          prompt: "grade it",
          schema: z.object({ grounded: z.boolean(), score: z.number() }),
        });
        expect(answer.object).toEqual({ grounded: true, score: 7 });
      } finally {
        release();
      }
      expect((await session.say("still there?")).completed).toBe(true);
    },
    { stubReply: "still here." },
  );

  test(
    "stubGenerate is a SEPARATE cursor, and it really reaches ctx.generate",
    async ({ session }) => {
      // One script cannot serve both: `ctx.generate` resolves its own model
      // instance, so element 0 would have to be the turn's first move AND the
      // first generate answer. Here the turn calls a tool that reasons with a
      // model, and the two scripts do not interleave.
      //
      // The assertion is on the TOOL'S RESULT deliberately. An earlier version
      // asserted only the turn's text, which passes whether or not the scripted
      // generate is wired to anything — and for a while it was not: the option
      // installed a stub, released it, and forwarded nothing. A no-op that its
      // own test cannot see is the failure this file exists to prevent.
      const turn = await session.say("what do you make of it?");
      expect(turn.text).toBe("the turn's own line");
      expect(toolResultIn(turn.toolCalls, "judge")).toEqual({ verdict: "sound" });
    },
    {
      stubReply: [{ tool: "judge", args: { claim: "it holds" } }, "the turn's own line"],
      stubGenerate: '{"verdict":"sound"}',
    },
  );

  test(
    "ctx.generate answers from the same script, so a reasoning tool works",
    async ({ session }) => {
      // `generateText` calls `doGenerate`, which the fake used to refuse — so
      // every tool that reasons with a model returned "doGenerate not
      // implemented" in a scripted run, and it read as the agent being broken.
      const { createGenerateFn } = await import("../generate.ts");
      const generate = createGenerateFn({
        llm: { kind: "eval-spec-generate", options: {} },
        env: { EVAL_SPEC_GENERATE_KEY: "k" },
      });
      const release = registerLlmKind("eval-spec-generate", {
        envVar: "EVAL_SPEC_GENERATE_KEY",
        label: "Spec generate",
        create: () => createFakeLanguageModel({ script: [{ type: "text", text: "graded: yes" }] }),
      });
      try {
        expect((await generate({ prompt: "grade this" })).text).toContain("graded: yes");
      } finally {
        release();
      }
      // The session itself is untouched by that probe and still answers.
      expect((await session.say("still there?")).completed).toBe(true);
    },
    { stubReply: "still here." },
  );
});
