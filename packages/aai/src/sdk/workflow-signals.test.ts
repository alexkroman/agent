// Copyright 2026 the AAI authors. MIT license.
/**
 * The derived signal token: one grammar for the body (`ctx.waitForSignal`,
 * `ctx.signalToken`) and the tool (`ctx.workflows.signalRun`), and a refusal
 * for a run that has no key to derive from.
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";
import { signalTokenFor, waitForSignalWorkflow, workflowSignalToken } from "./workflow-signals.ts";

describe("workflowSignalToken", () => {
  test("is `<workflow>:<key>:<label>`", () => {
    expect(workflowSignalToken("digest", "sess-1", "approval")).toBe("digest:sess-1:approval");
  });
});

describe("ctx.signalToken", () => {
  test("derives the token from the run's own key", () => {
    const ctx = createWorkflowContext({ workflow: "digest", key: "sess-1" });
    expect(ctx.signalToken("transcript")).toBe("digest:sess-1:transcript");
  });

  test("THROWS for a run with no key, naming the fix", () => {
    const ctx = createWorkflowContext({ workflow: "digest" });
    expect(() => ctx.signalToken("transcript")).toThrow(/has no key/);
    expect(() => signalTokenFor({ workflow: "digest", key: undefined }, "t")).toThrow(
      /ctx\.workflows\.start\(def, input, \{ key \}\)/,
    );
  });
});

describe("ctx.waitForSignal", () => {
  test("waits on the derived token, so a spec keys its hooks by it", async () => {
    const ctx = createWorkflowContext({
      workflow: "digest",
      key: "sess-1",
      hooks: { "digest:sess-1:approval": { approved: true } },
    });
    const answer = await ctx.waitForSignal("approval", {
      schema: z.object({ approved: z.boolean() }),
    });
    expect(answer).toEqual({ approved: true });
    expect(ctx.waited).toEqual(["digest:sess-1:approval"]);
  });

  test("a deadline adds the unanswered arm, exactly as waitFor's does", async () => {
    const ctx = createWorkflowContext({ workflow: "digest", key: "sess-1" });
    await expect(ctx.waitForSignal("approval", { timeoutMs: 10 })).resolves.toBeUndefined();
  });

  test("refuses a keyless run before touching the wait, naming the method the body called", async () => {
    const ctx = createWorkflowContext({ workflow: "digest" });
    const err = await ctx.waitForSignal("approval").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/has no key/);
    // The body wrote `waitForSignal`, so the sentence says that — not the
    // `signalToken` it derives through.
    expect((err as Error).message).toMatch(/^ctx\.waitForSignal\("approval"\)/);
    expect(ctx.waited).toEqual([]);
  });

  test("hands the options through unchanged on a bare host", async () => {
    const calls: unknown[] = [];
    const host = {
      workflow: "w",
      key: "k",
      waitFor: async (token: string, options?: unknown) => {
        calls.push([token, options]);
        return "payload";
      },
    };
    await waitForSignalWorkflow(host, "l");
    await waitForSignalWorkflow(host, "l", { timeoutMs: 5 });
    expect(calls).toEqual([
      ["w:k:l", undefined],
      ["w:k:l", { timeoutMs: 5 }],
    ]);
  });
});
