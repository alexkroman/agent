// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeWorkflowEval`: two real suites registered through it, one with an
 * `env` of its own and one relying on the stub-mode credential placeholder.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { stepEnv, stepReport } from "@alexkroman1/aai/step";
import { expect, vi } from "vitest";
import { z } from "zod";
import { describeWorkflowEval } from "./describe-workflows.ts";

const digest = workflow({
  description: "Digest a link",
  input: z.object({ url: z.string() }),
  run: async (input: { url: string }, ctx) => {
    await stepReport(`reading ${input.url}`);
    await ctx.sleep("nap", 10_000);
    return { headline: `about ${input.url}` };
  },
});

/** Reads a DECLARED credential from inside the body, through the published slot. */
const keyReader = workflow({
  input: z.object({}),
  run: async () => ({ key: stepEnv("A_KEY_NOBODY_HAS") }),
});

const app = agent({
  name: "Digest App",
  mode: "workflow-app",
  workflows: { digest },
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});

// Read at COLLECTION time by `describeWorkflowEval` below, which is why it is
// stubbed here rather than in a hook — the same rule `describe.test.ts` follows.
vi.stubEnv("AAI_EVAL_STUB", "1");

describeWorkflowEval(
  app,
  (test) => {
    test("drives a real run of the real body", async ({ app: opened, mode }) => {
      expect(mode).toBe("stub");
      const run = await opened.run(digest, { url: "https://example.test/x" });
      expect(run.output).toEqual({ headline: "about https://example.test/x" });
    });

    test(
      "a live-only case does not run when the providers are faked",
      async () => {
        expect.fail("a { live: true } case must be skipped in stub mode");
      },
      { live: true },
    );
  },
  { env: { ASSEMBLYAI_API_KEY: "k" } },
);

// A SECOND suite, with no `env` of its own, so the placeholder path is covered:
// a step reads its credential with `requireStepEnv`, which throws by name for a
// key nothing published — and CI's scripted run has no key at all, so without a
// placeholder every workflow template's stub gate would fail on the credential
// rather than on anything a case wrote.
describeWorkflowEval(
  agent({
    name: "Keyless App",
    mode: "workflow-app",
    workflows: { keyReader },
    requiredEnv: ["A_KEY_NOBODY_HAS"],
  }),
  (test) => {
    test("fills a missing declared key with a placeholder in stub mode", async ({
      app: opened,
    }) => {
      const run = await opened.run(keyReader, {});
      expect(run.status).toBe("completed");
      // Read from inside the body through the PUBLISHED slot, so this is the
      // value `requireStepEnv` would have thrown over.
      expect(run.output).toEqual({ key: "aai-eval-stub-credential" });
    });
  },
  {},
);
