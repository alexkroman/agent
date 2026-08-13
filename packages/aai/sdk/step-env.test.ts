// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the step env.
 *
 * The property that cannot be asserted here is the one the module doc argues
 * for: that a step bundle's own copy of this module reads the slot the guest's
 * copy published. Two module instances need two bundles and a real transform,
 * which is `aai-cli`'s `dev-workflow.integration.test.ts`. What IS assertable is
 * every rule the slot itself carries — replace, drop-undefined, no per-key
 * fallback once published, and the unpublished fallback that keeps an exported
 * step callable from a spec.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { publishStepEnv, requireStepEnv, stepEnv } from "./step-env.ts";

const SLOT = Symbol.for("@alexkroman1/aai.stepEnv");

/** Return the process to "nothing has published", which is how it starts. */
function unpublish(): void {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
}

afterEach(unpublish);

describe("stepEnv", () => {
  test("reads the published agent env", () => {
    publishStepEnv({ ASSEMBLYAI_API_KEY: "sk-live" });
    expect(stepEnv("ASSEMBLYAI_API_KEY")).toBe("sk-live");
  });

  test("does NOT fall back per key once an env is published", () => {
    // The parity rule: what a step can read is what `.env` and `aai secret put`
    // declare, so a shell-exported key must not make a workflow work under
    // `aai dev` and fail after a deploy.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "from-the-shell");
    publishStepEnv({ SOMETHING_ELSE: "x" });
    expect(stepEnv("ASSEMBLYAI_API_KEY")).toBeUndefined();
  });

  test("falls back to the process env when nothing has published", () => {
    // A spec calling an exported step directly, or a script — there is no agent
    // env in the process at all, and answering `undefined` would make every
    // step untestable without reaching for the publisher.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "from-the-shell");
    expect(stepEnv("ASSEMBLYAI_API_KEY")).toBe("from-the-shell");
  });

  test("publishing replaces, because a redeploy is not a merge", () => {
    publishStepEnv({ A: "1", B: "2" });
    publishStepEnv({ A: "3" });
    expect(stepEnv("A")).toBe("3");
    expect(stepEnv("B")).toBeUndefined();
  });

  test("drops an undefined value rather than storing the key", () => {
    // Otherwise a declared-but-unset `.env` entry would read as present and
    // `requireStepEnv` would hand a provider an empty credential.
    publishStepEnv({ ASSEMBLYAI_API_KEY: undefined });
    expect(stepEnv("ASSEMBLYAI_API_KEY")).toBeUndefined();
  });
});

describe("requireStepEnv", () => {
  test("returns the value when it is set", () => {
    publishStepEnv({ ASSEMBLYAI_API_KEY: "sk-live" });
    expect(requireStepEnv("ASSEMBLYAI_API_KEY")).toBe("sk-live");
  });

  test("names the key and how to set it", () => {
    publishStepEnv({});
    expect(() => requireStepEnv("ASSEMBLYAI_API_KEY")).toThrow(
      /Missing ASSEMBLYAI_API_KEY.*aai secret put ASSEMBLYAI_API_KEY/s,
    );
  });

  test("treats an empty value as absent", () => {
    // An empty string authenticates nothing, and a provider reporting a bad key
    // is a worse report than this one.
    publishStepEnv({ ASSEMBLYAI_API_KEY: "" });
    expect(() => requireStepEnv("ASSEMBLYAI_API_KEY")).toThrow(/Missing ASSEMBLYAI_API_KEY/);
  });
});
