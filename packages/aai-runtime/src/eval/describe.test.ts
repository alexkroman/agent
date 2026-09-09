// Copyright 2026 the AAI authors. MIT license.
/**
 * One real suite registered through `describeEval`, plus the pieces around it.
 *
 * `describeEval` is what a template ships, so the per-case session, the stub
 * install and the `{ live: true }` skip are exercised here rather than left to
 * another package's run. The MODE decision it opens with moved out with its
 * module — `eval-mode.test.ts`.
 *
 * **It is FORCED into stub mode** (`vi.stubEnv` at module scope, which is when
 * `describeEval` reads the environment). Without that, this file would drive a
 * LIVE model — in the unit tier, on the key of whoever happens to have one
 * exported.
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { requireStepEnv } from "@alexkroman1/aai/step";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { announceEvalCoverage, announceEvalMode, emptySuiteReason } from "./_announce.ts";
import { describeEval } from "./describe.ts";
import { toolResultIn } from "./events.ts";
import { installStubLlm, STUB_LLM_API_KEY_ENV } from "./stub-llm.ts";

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

describe("announceEvalCoverage", () => {
  /**
   * The counts nothing else reports. Vitest prints `2 skipped` per FILE and
   * `aai eval --json` answers `{"passed":true}` with no counts at all, so a
   * suite whose every case is live-only read as a green run — see
   * {@link emptySuiteReason}.
   */
  test("says how many of the suite's cases this mode will run", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceEvalCoverage("Desk", "stub", 3, 1);
    expect(stderr).toHaveBeenCalledWith(
      "eval: Desk — 2 of 3 case(s) run against the scripted model; 1 skipped as live-only.\n",
    );
  });

  test("an all-ran suite still gets a line — a number that hides is not read", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceEvalCoverage("Desk", "live", 2, 0);
    expect(stderr).toHaveBeenCalledWith(
      "eval: Desk — 2 of 2 case(s) run against the live model.\n",
    );
  });
});

describe("emptySuiteReason", () => {
  test("a suite whose every case is skipped by the mode gate FAILS", () => {
    // Measured on a scaffolded project: two `{ live: true }` cases with no key
    // printed `2 skipped`, `{"ok":true,"data":{"passed":true}}` and exited 0.
    const reason = emptySuiteReason("stub", 2, 2);
    expect(reason).toContain("{ live: true }");
    expect(reason).toContain("measured nothing");
    expect(reason).toContain("stubReply");
  });

  test("the mirror: an all-scripted suite on a live model", () => {
    expect(emptySuiteReason("live", 3, 3)).toContain("{ scripted: true }");
  });

  test("one runnable case is enough — the gate is 'nothing ran', not 'few ran'", () => {
    expect(emptySuiteReason("stub", 3, 2)).toBeUndefined();
  });

  test("a suite that declared nothing is left to vitest, which already fails it", () => {
    expect(emptySuiteReason("stub", 0, 0)).toBeUndefined();
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
    "a stubGenerate the call's own schema rejects fails, rather than answering a typed lie",
    async ({ session }) => {
      // `ctx.generate({ schema })` is `generateText` + `Output.object` over
      // `jsonSchema(...)`, which carries no validator — so a script of
      // `{"verdict":123}` against `z.object({ verdict: z.string() })` used to
      // RESOLVE, typed as the schema's shape and holding a number. The tool
      // then read `verdict.length` off it and the case passed.
      //
      // The refusal arrives as the tool's own failure, which is the honest
      // shape: `judge` is what called `generate`.
      const turn = await session.say("what do you make of it?");
      expect(toolResultIn(turn.toolCalls, "judge", z.object({ error: z.string() })).error).toMatch(
        // Both halves matter, and they come from different layers now: the
        // rejection is `createGenerateFn`'s (so a LIVE model is caught too),
        // and the script-blaming sentence is the eval harness re-attributing
        // it — "the model" being the case author's own script here.
        /stubGenerate answered something the call's own schema rejects.*measuring the script/s,
      );
    },
    {
      stubReply: [{ tool: "judge", args: { claim: "it holds" } }, "the turn's own line"],
      stubGenerate: '{"verdict":123}',
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

/**
 * A body that reads a declared key the way a real step does — `requireStepEnv`,
 * which THROWS by name for a key the agent env does not carry.
 */
const keyReader = workflow({
  input: z.object({}),
  run: async () => ({ key: requireStepEnv("A_KEY_NOBODY_HAS") }),
});

/** The handoff shape: a tool starts the run and answers the turn. */
const go = tool({
  description: "Start the key reader.",
  execute: async (_args, ctx) => {
    const runId = await ctx.workflows.start(keyReader, {});
    return { runId };
  },
});

// A voice agent that HANDS OFF to a run, with no `env` of its own: the engine
// `describeEval` opens beside the session used to get exactly what the suite
// passed, which for a keyless CI run is nothing — so every such template carried
// a `{ ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "eval-scripted-key" }`
// to keep its steps from failing on the credential before reaching the script.
// `describeWorkflowEval` had already settled the question for a workflow app;
// this is the same placeholder reaching the same engine by the other door.
describeEval(
  withTools(
    agent({ name: "Handoff Suite", workflows: { keyReader }, requiredEnv: ["A_KEY_NOBODY_HAS"] }),
    { go },
  ),
  (test) => {
    test(
      "fills a declared key nobody has with a placeholder for the run a tool starts",
      async ({ session, workflows }) => {
        const turn = await session.say("go");
        expect(turn.toolCalls.map((call) => call.name)).toEqual(["go"]);
        const [run] = (await workflows?.settleAll()) ?? [];
        expect(run?.status).toBe("completed");
        // Read from inside the body through the PUBLISHED slot, so this is the
        // value `requireStepEnv` would have thrown over.
        expect(run?.output).toEqual({ key: "aai-eval-stub-credential" });
      },
      { stubReply: [{ tool: "go", args: {} }, "started it"] },
    );
  },
);
