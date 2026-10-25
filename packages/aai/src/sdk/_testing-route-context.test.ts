// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createRouteContext } from "./_testing-route-context.ts";
import type { RouteContext } from "./agent-routes.ts";
import { createStubWorkflows } from "./testing-workflows.ts";

describe("createRouteContext", () => {
  test("supplies every RouteContext field, inert", async () => {
    // The field list is the assertion: a hand-built literal is what omits the
    // field the runtime gained last.
    const ctx = createRouteContext();
    expect(Object.keys(ctx).sort()).toEqual([
      "clientTranscript",
      "env",
      "sessionTranscript",
      "signal",
      "speech",
      "workflows",
    ]);
    expect(ctx.env).toEqual({});
    await expect(ctx.clientTranscript("c_1")).resolves.toEqual({ sessions: [] });
    await expect(ctx.sessionTranscript("s_1")).resolves.toEqual([]);
    expect(ctx.speech("s_1")).toBeUndefined();
    expect(ctx.signal.aborted).toBe(false);
    await expect(ctx.workflows.start("w", {})).rejects.toThrow(/createStubWorkflows/);
  });

  test("overrides win, and an `undefined` override leaves the default", async () => {
    const workflows = createStubWorkflows({ start: () => Promise.resolve("wrun_9") });
    const controller = new AbortController();
    const ctx = createRouteContext({
      env: { CALLS_API_KEY: "k" },
      workflows,
      signal: controller.signal,
      sessionTranscript: undefined,
    });
    expect(ctx.env).toEqual({ CALLS_API_KEY: "k" });
    expect(ctx.workflows).toBe(workflows);
    expect(ctx.signal).toBe(controller.signal);
    await expect(ctx.sessionTranscript("s_1")).resolves.toEqual([]);
    // Assignable where a handler takes one: no cast on the way in.
    const typed: RouteContext = ctx;
    expect(typed).toBe(ctx);
  });
});
