// Copyright 2026 the AAI authors. MIT license.
// The eval harness's own seams. Nothing here runs a case — a case needs a real
// workspace, a compiler and a model — but three of this module's decisions can
// be wrong in the one direction that matters, which is the direction that makes
// the eval report a finding about ITSELF rather than about the coding agent.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  credentialProbe,
  refusingFetch,
  STUDIO_EVAL_PROMPT,
  studioEvalModel,
} from "./_eval-harness.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("STUDIO_EVAL_PROMPT", () => {
  // The module's whole argument for this constant being thin: a base prompt
  // that told the agent to copy templates verbatim, or not to delete a failing
  // spec, would turn the corresponding case into a measurement of this string.
  // Both of those instructions exist in the guest's own shipped surfaces, which
  // is what the cases are there to grade — so a well-meaning edit here is
  // exactly how those two cases would stop measuring anything, silently.
  test.each([
    ["template", /template/i],
    ["verbatim / retyping", /verbatim|retype/i],
    ["tests and specs", /\btests?\b|\bspec\b/i],
    ["deleting", /delete|remove/i],
    ["type checking", /type-?check|compile|tsc/i],
  ])("says nothing about %s — that would pre-answer a case", (_what, pattern) => {
    expect(STUDIO_EVAL_PROMPT).not.toMatch(pattern);
  });

  test("still states the job, so a case is not measuring an empty prompt", () => {
    expect(STUDIO_EVAL_PROMPT).toMatch(/tools?/i);
    expect(STUDIO_EVAL_PROMPT).toMatch(/workspace/i);
    expect(STUDIO_EVAL_PROMPT.length).toBeGreaterThan(100);
  });
});

describe("studioEvalModel", () => {
  test("defaults to the studio's own shipped model id", () => {
    vi.stubEnv("AAI_EVAL_STUDIO_MODEL", undefined);
    // The literal, and the drift it carries, are argued in the module doc: the
    // real default is `studioLlmModelId()` in `aai-studio-server`, which
    // `guest-package-boundary` denies this package.
    expect(studioEvalModel()).toBe("gpt-5.5");
  });

  test("takes an override, trimmed", () => {
    vi.stubEnv("AAI_EVAL_STUDIO_MODEL", "  claude-sonnet-4-6 ");
    expect(studioEvalModel()).toBe("claude-sonnet-4-6");
  });

  test("treats blank as unset, which is what a CI variable set to nothing is", () => {
    vi.stubEnv("AAI_EVAL_STUDIO_MODEL", "   ");
    expect(studioEvalModel()).toBe("gpt-5.5");
  });
});

describe("credentialProbe", () => {
  // The mode is announced about the REAL definition rather than a stand-in,
  // which is the bug `resolveEvalMode`'s `overrides` parameter was added for: a
  // gate reading a different definition than the run announces the wrong mode
  // while holding the key the run would have used. So the probe has to keep
  // being `createStudioAgent`'s output.
  test("is the coding agent's own definition, not a look-alike", () => {
    const def = credentialProbe();
    expect(def.text).toBe(true);
    expect(def.name).toBe("AAI Studio");
    // One name from each tool family, so a family that stopped being merged
    // would change what credential question is asked.
    for (const name of ["write_file", "use_template", "test_agent", "add_dependency"]) {
      expect(def.tools, name).toHaveProperty(name);
    }
    expect(def.builtinTools).toEqual(["visit_webpage", "get_page_design", "web_search"]);
  });

  test("carries the model the announce line names, and never a credential", () => {
    vi.stubEnv("AAI_EVAL_STUDIO_MODEL", "probe-model-1");
    const def = credentialProbe();
    expect(JSON.stringify(def.llm)).toContain("probe-model-1");
    // The caller's key rides in as `providerEnv`, never on the definition —
    // the same claim `studio/agent.test.ts` makes about the shipped path.
    expect(JSON.stringify(def)).not.toMatch(/apiKey|chatToken/);
  });
});

describe("refusingFetch", () => {
  // A case that reached the network would spend a live web search and answer
  // differently on a machine with no egress. The refusal has to NAME the URL,
  // because a case whose builtin was refused reads the rejection as the tool's
  // own failure otherwise.
  test("rejects, naming the URL and how to opt in", async () => {
    await expect(refusingFetch("https://example.com/pricing")).rejects.toThrow(
      /https:\/\/example\.com\/pricing/,
    );
    await expect(refusingFetch(new Request("https://example.com/x"))).rejects.toThrow(
      /pass `fetch` in the case options/,
    );
  });
});
