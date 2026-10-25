// Copyright 2026 the AAI authors. MIT license.
/**
 * `workflows/<name>.ts` becoming an `agent({ workflows })` entry — the rules
 * both discovery sources (the CLI's generated entry, `virtual:aai/agent`) hand
 * their modules to.
 */

import { describe, expect, test, vi } from "vitest";
import { withWorkflows, workflowRegistry } from "./manifest-workflows.ts";
import { workflow } from "./workflow.ts";

const digest = workflow({ description: "digest", run: async () => ({ ok: true }) });
const recap = workflow({ description: "recap", run: async () => "done" });

describe("workflowRegistry", () => {
  test("registers a default-exported def under its file name, from either path prefix", () => {
    const registry = workflowRegistry({
      "workflows/digest.ts": { default: digest },
      "/abs/project/workflows/recap.ts": { default: recap },
    });
    expect(registry).toEqual({ digest, recap });
  });

  test("skips a body's helpers: no default export, or one that is not a def", () => {
    const registry = workflowRegistry({
      "workflows/digest.ts": { default: digest },
      "workflows/prompts.ts": { WRITER_SYSTEM: "…" },
      "workflows/media.ts": { default: { ANALYSIS_FORMAT: "wav" } },
      "workflows/tokens.ts": { default: (id: string) => id },
      "workflows/digest.test.ts": { default: digest },
      "workflows/digest.test-d.ts": { default: digest },
    });
    expect(Object.keys(registry)).toEqual(["digest"]);
  });

  test("a def that IS a workflow but is nested, misnamed or declared twice is an error naming it", () => {
    expect(() => workflowRegistry({ "workflows/daily/digest.ts": { default: digest } })).toThrow(
      /workflows\/daily\/digest\.ts .* nested/,
    );
    expect(() => workflowRegistry({ "workflows/1digest.ts": { default: digest } })).toThrow(
      /"1digest" is not a usable workflow name/,
    );
    expect(() => workflowRegistry({ "workflows/my digest.ts": { default: digest } })).toThrow(
      /not a usable workflow name/,
    );
    expect(() =>
      workflowRegistry({
        "workflows/digest.ts": { default: digest },
        "workflows/digest.mts": { default: recap },
      }),
    ).toThrow(/Two files declare the workflow "digest"/);
  });
});

describe("withWorkflows", () => {
  test("adds discovered workflows beside the declared ones, on a NEW object", () => {
    const def = { name: "App", workflows: { recap } };
    const lowered = withWorkflows(def, { digest });
    expect(lowered).not.toBe(def);
    expect(lowered.workflows).toEqual({ recap, digest });
    expect(def.workflows).toEqual({ recap });
  });

  test("an explicit declaration wins a clash, with a warning naming the file", () => {
    const warn = vi.fn<(message: string) => void>();
    const other = workflow({ run: async () => "other" });
    const lowered = withWorkflows({ workflows: { digest } }, { digest: other }, { warn });
    expect(lowered.workflows?.digest).toBe(digest);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /workflows\/digest\.ts .* declares a different "digest"/,
    );
  });

  test("the SAME def declared and discovered is silent — the ordinary case", () => {
    const warn = vi.fn<(message: string) => void>();
    const lowered = withWorkflows({ workflows: { digest } }, { digest }, { warn });
    expect(lowered.workflows).toEqual({ digest });
    expect(warn).not.toHaveBeenCalled();
  });

  test("a def with nothing declared and nothing discovered is handed back as it was", () => {
    const def = { name: "Voice" };
    expect(withWorkflows(def, {})).toBe(def);
    expect(withWorkflows({ name: "Voice", workflows: undefined }, { digest }).workflows).toEqual({
      digest,
    });
  });
});
