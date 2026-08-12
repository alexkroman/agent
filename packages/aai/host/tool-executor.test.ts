// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { ToolContext, ToolDef } from "../sdk/types.ts";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "../sdk/workflow.ts";
import { makeTool, sleep } from "./_test-utils.ts";
import { executeToolCall } from "./tool-executor.ts";

function run(
  name: string,
  args: Record<string, unknown>,
  tool: ToolDef,
  extra?: Record<string, unknown>,
) {
  return executeToolCall(name, args, { tool, env: {}, ...extra });
}

describe("executeToolCall", () => {
  test("returns string result from tool", async () => {
    expect(await run("test", {}, makeTool({ run: () => "hello" }))).toBe("hello");
  });

  test("calls the deprecated execute spelling, validating the deprecated schema", async () => {
    // Same reason as `agentToolsToSchemas`: an agent that never went through
    // `tool()` carries the old names, and a reader that only knows `run` would
    // report it as a tool with no handler.
    const tool: ToolDef = {
      description: "greet",
      inputSchema: z.object({ name: z.string() }),
      execute: (args) => `hi ${(args as { name: string }).name}`,
    };
    expect(await run("greet", { name: "Bo" }, tool)).toBe("hi Bo");
    expect(await run("greet", { name: 7 }, tool)).toContain("Invalid arguments");
  });

  test("serializes non-string result as JSON", async () => {
    expect(await run("test", {}, makeTool({ run: () => ({ count: 42 }) }))).toBe('{"count":42}');
  });

  test("returns 'null' for null/undefined result", async () => {
    expect(await run("test", {}, makeTool({ run: () => null }))).toBe("null");
  });

  test("stringifies a non-JSON-serializable result instead of returning undefined", async () => {
    // JSON.stringify(function) is undefined — the String() fallback keeps the
    // contract that the provider always gets a string.
    const fn = () => "nope";
    const result = await run("test", {}, makeTool({ run: () => fn as unknown as string }));
    expect(typeof result).toBe("string");
    expect(result).toBe(String(fn));
  });

  test("validates args against parameter schema", async () => {
    const tool = makeTool({
      input: z.object({ name: z.string() }),
      run: (args) => `hi ${(args as { name: string }).name}`,
    });
    expect(await run("greet", { name: "alice" }, tool)).toBe("hi alice");
  });

  test("returns error for invalid args", async () => {
    const tool = makeTool({ input: z.object({ name: z.string() }), run: () => "ok" });
    const result = await run("greet", { name: 123 }, tool);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Invalid arguments");
    expect(parsed.error).toContain("greet");
  });

  test("returns error when tool throws", async () => {
    const tool = makeTool({
      run: () => {
        throw new Error("boom");
      },
    });
    expect(await run("fail", {}, tool)).toBe(JSON.stringify({ error: "boom" }));
  });

  test("returns error string when tool throws", async () => {
    const tool = makeTool({
      run: () => {
        throw new Error("string error");
      },
    });
    expect(await run("fail", {}, tool)).toBe(JSON.stringify({ error: "string error" }));
  });

  test("passes env to tool context", async () => {
    const tool = makeTool({ run: (_args, ctx) => ctx.env.API_KEY ?? "missing" });
    expect(await run("test", {}, tool, { env: { API_KEY: "secret" } })).toBe("secret");
  });

  test("passes messages to tool context", async () => {
    const tool = makeTool({ run: (_args, ctx) => String(ctx.messages.length) });
    expect(await run("test", {}, tool, { messages: [{ role: "user", content: "hi" }] })).toBe("1");
  });

  test("db throws when not provided", async () => {
    const tool = makeTool({
      run: (_args, ctx) => {
        void ctx.db;
        return "no error";
      },
    });
    const result = await run("test", {}, tool);
    expect(JSON.parse(result)).toEqual({
      error:
        "Storage is not enabled for this app. Enable it with `aai storage enable` (CLI) or " +
        "Settings → Database in the studio; under `aai dev`, set DATABASE_URL in the " +
        "project .env.",
    });
  });

  // Both methods, because a tool that polls a run's status is as likely to be
  // the first thing an author writes as one that starts it.
  test.each([
    ["start", (ctx: ToolContext) => ctx.workflows.start("digest", {})],
    ["get", (ctx: ToolContext) => ctx.workflows.get("run-1")],
  ])("ctx.workflows.%s rejects with the unavailable message with no engine", async (_m, call) => {
    const result = await run("test", {}, makeTool({ run: (_args, ctx) => call(ctx) }));
    expect(JSON.parse(result)).toEqual({ error: WORKFLOWS_UNAVAILABLE_MESSAGE });
  });

  test("ctx.generate rejects when no host generation is wired", async () => {
    const tool = makeTool({ run: (_args, ctx) => ctx.generate({ prompt: "hi" }) });
    const result = await run("test", {}, tool);
    expect(JSON.parse(result)).toEqual({
      error: "generate is not available in this execution context",
    });
  });

  test("ctx.workflows forwards to the engine when one is wired", async () => {
    const start = vi.fn(() => Promise.resolve("run-1"));
    const tool = makeTool({
      run: (_args, ctx) => ctx.workflows.start("digest", { topic: "ai" }),
    });
    const result = await run("test", {}, tool, {
      workflows: { start, get: () => Promise.resolve(undefined) },
    });
    expect(result).toBe("run-1");
    expect(start).toHaveBeenCalledWith("digest", { topic: "ai" });
  });

  test("handles async tool execution", async () => {
    const tool = makeTool({
      run: async () => {
        await sleep(10);
        return "async result";
      },
    });
    expect(await run("test", {}, tool)).toBe("async result");
  });

  test("times out tool that runs longer than TOOL_EXECUTION_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const tool = makeTool({
      run: () =>
        new Promise<never>(() => {
          /* never resolves */
        }),
    });
    const promise = run("slow", {}, tool);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await promise).toBe(JSON.stringify({ error: 'Tool "slow" timed out after 30000ms' }));
    vi.useRealTimers();
  });

  test("ctx.send calls the send callback", async () => {
    const sends: Array<{ event: string; data: unknown }> = [];
    const tool = makeTool({
      run: (_args, ctx) => {
        ctx.send("game_state", { hp: 10 });
        return "ok";
      },
    });
    const result = await run("sender", {}, tool, {
      send: (event: string, data: unknown) => sends.push({ event, data }),
    });
    expect(result).toBe("ok");
    expect(sends).toEqual([{ event: "game_state", data: { hp: 10 } }]);
  });

  test("ctx.send is a no-op when no send callback provided", async () => {
    const tool = makeTool({
      run: (_args, ctx) => {
        ctx.send("test", {});
        return "ok";
      },
    });
    expect(await run("sender", {}, tool)).toBe("ok");
  });
});

describe("executeToolCall — cancellation", () => {
  test("ctx.signal follows the caller's signal", async () => {
    // ctx.signal is a per-call signal (so a timeout can fire it too), chained
    // to the caller's turn signal: aborting the turn aborts the call.
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const gate = Promise.withResolvers<string>();
    const tool = makeTool({
      run: (_args, ctx) => {
        seen = ctx.signal;
        return gate.promise;
      },
    });
    const running = run("probe", {}, tool, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
    gate.resolve("late");
    await running;
  });

  test("a timeout fires ctx.signal so the tool can stop its side effects", async () => {
    // pTimeout only settles the await; without the per-call abort a timed-out
    // tool kept running — and kept mutating shared ctx.state — after its
    // error result was already committed to the turn.
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const tool = makeTool({
        run: (_args, ctx) => {
          seen = ctx.signal;
          return new Promise<never>(() => {
            /* never resolves */
          });
        },
      });
      const promise = run("slow", {}, tool);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(JSON.parse(await promise)).toMatchObject({
        error: expect.stringContaining("timed out"),
      });
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ctx.signal is provided even when the caller passes none", async () => {
    const tool = makeTool({ run: (_args, ctx) => String(ctx.signal !== undefined) });
    expect(await run("probe", {}, tool)).toBe("true");
  });

  test("a pre-aborted signal short-circuits before the tool runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = vi.fn(() => "should not run");
    const result = await run("skip", {}, makeTool({ run: handler }), { signal: controller.signal });
    expect(JSON.parse(result)).toMatchObject({
      error: expect.stringContaining("cancelled before it ran"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("aborting mid-flight settles a hung tool with a tool error", async () => {
    const controller = new AbortController();
    let started = false;
    const tool = makeTool({
      run: () => {
        started = true;
        return new Promise<never>(() => {
          /* never resolves */
        });
      },
    });
    const promise = run("hang", {}, tool, { signal: controller.signal });
    // Wait until the tool is genuinely in flight — a single-tick delay is
    // racy under CI load.
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    const result = await promise;
    expect(JSON.parse(result)).toMatchObject({ error: expect.stringMatching(/abort/i) });
  });
});
