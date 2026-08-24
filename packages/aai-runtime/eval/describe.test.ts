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

import { agent } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { describeEval, resolveEvalMode } from "./describe.ts";
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

// Read by `describeEval` below at COLLECTION time, which is why the stub is set
// here rather than in a hook. `unstubEnvs` restores it before each test runs,
// which is fine: the mode was already decided.
vi.stubEnv("AAI_EVAL_STUB", "1");

describeEval(agent({ name: "Stub Suite" }), (test) => {
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
});
