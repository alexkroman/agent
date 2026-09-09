// Copyright 2026 the AAI authors. MIT license.
/**
 * The mode decision, which is the part of an eval suite with a WRONG answer
 * available: silently downgrading a pipeline that asked to measure, or silently
 * spending tokens in one that did not. Both are quiet, so both are asserted
 * directly rather than through a suite that would only report the symptom.
 *
 * `describeEval` itself — the per-case session, the stub install, the
 * `{ live: true }` skip — is `describe.test.ts` next door.
 */

import { agent } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { resolveEvalMode } from "./eval-mode.ts";

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
