// Copyright 2025 the AAI authors. MIT license.

import type { ToolDef } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
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
    expect(await run("test", {}, makeTool({ execute: () => "hello" }))).toBe("hello");
  });

  test("serializes non-string result as JSON", async () => {
    expect(await run("test", {}, makeTool({ execute: () => ({ count: 42 }) }))).toBe(
      '{"count":42}',
    );
  });

  test("returns 'null' for null/undefined result", async () => {
    expect(await run("test", {}, makeTool({ execute: () => null }))).toBe("null");
  });

  test("stringifies a non-JSON-serializable result instead of returning undefined", async () => {
    // JSON.stringify(function) is undefined — the String() fallback keeps the
    // contract that the provider always gets a string.
    const fn = () => "nope";
    const result = await run("test", {}, makeTool({ execute: () => fn as unknown as string }));
    expect(typeof result).toBe("string");
    expect(result).toBe(String(fn));
  });

  test("validates args against parameter schema", async () => {
    const tool = makeTool({
      inputSchema: z.object({ name: z.string() }),
      execute: (args) => `hi ${(args as { name: string }).name}`,
    });
    expect(await run("greet", { name: "alice" }, tool)).toBe("hi alice");
  });

  test("returns error for invalid args", async () => {
    const tool = makeTool({ inputSchema: z.object({ name: z.string() }), execute: () => "ok" });
    const result = await run("greet", { name: 123 }, tool);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Invalid arguments");
    expect(parsed.error).toContain("greet");
  });

  test("returns error when tool throws", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
    });
    expect(await run("fail", {}, tool)).toBe(JSON.stringify({ error: "boom" }));
  });

  test("returns error string when tool throws", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("string error");
      },
    });
    expect(await run("fail", {}, tool)).toBe(JSON.stringify({ error: "string error" }));
  });

  test("passes env to tool context", async () => {
    const tool = makeTool({ execute: (_args, ctx) => ctx.env.API_KEY ?? "missing" });
    expect(await run("test", {}, tool, { env: { API_KEY: "secret" } })).toBe("secret");
  });

  test("passes messages to tool context", async () => {
    const tool = makeTool({ execute: (_args, ctx) => String(ctx.messages.length) });
    expect(await run("test", {}, tool, { messages: [{ role: "user", content: "hi" }] })).toBe("1");
  });

  test("the context carries NO db, so a tool reaching for one finds nothing", async () => {
    // `ctx.db` is gone: the platform provisions no database and no longer hands one
    // to tool code, so an author who wants SQL brings their own client and
    // credential. This used to answer a curated "storage is not enabled" message.
    //
    // Asserted rather than deleted, because "the field is absent" is the contract
    // now and a tool written against the old API has to fail LOUDLY rather than
    // reading `undefined` and moving on.
    const tool = makeTool({
      execute: (_args, ctx) => {
        // Read through an assertion because the field is GONE from the type — which
        // is the contract. A tool written against the old API sees `undefined`, and
        // this asserts that rather than that some replacement exists.
        const reached = (ctx as { db?: unknown }).db;
        return reached === undefined ? "no ctx.db" : "unexpectedly had one";
      },
    });
    const result = await run("test", {}, tool);
    // A string result comes back raw, not JSON-wrapped.
    expect(result).toBe("no ctx.db");
  });

  test("handles async tool execution", async () => {
    const tool = makeTool({
      execute: async () => {
        await sleep(10);
        return "async result";
      },
    });
    expect(await run("test", {}, tool)).toBe("async result");
  });

  test("times out tool that runs longer than TOOL_EXECUTION_TIMEOUT_MS", async () => {
    // `try`/`finally` is load-bearing here and not the dead structure the root
    // guide warns about: `restoreMocks` restores spies, and nothing in the
    // config restores TIMERS. Bare, a failing assertion below skipped
    // `useRealTimers()` and left the five cancellation specs after it running
    // on a clock nothing advances. The sibling below already had it.
    vi.useFakeTimers();
    try {
      const tool = makeTool({
        execute: () =>
          new Promise<never>(() => {
            /* never resolves */
          }),
      });
      const promise = run("slow", {}, tool);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await promise).toBe(JSON.stringify({ error: 'Tool "slow" timed out after 30000ms' }));
    } finally {
      vi.useRealTimers();
    }
  });

  test("ctx.send calls the send callback", async () => {
    const sends: Array<{ event: string; data: unknown }> = [];
    const tool = makeTool({
      execute: (_args, ctx) => {
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
      execute: (_args, ctx) => {
        ctx.send("test", {});
        return "ok";
      },
    });
    expect(await run("sender", {}, tool)).toBe("ok");
  });
});

describe("executeToolCall — reporting a THROW", () => {
  // `tool` is one of eight SessionErrorCode values and was emitted by nothing.
  // A throwing tool produced no error frame and no session event — only a
  // logger.warn in a ring buffer that dies with the sandbox — so the likeliest
  // bug in a voice agent was also the least observable one.
  test("onUncaught fires when execute throws, and names the tool", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({
      execute: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'slice')");
      },
    });
    await run("lookup_note", {}, tool, { onUncaught });
    expect(onUncaught).toHaveBeenCalledTimes(1);
    // The raw error never names the tool; the model gets `errorMessage(err)`
    // alone, so the tool name is the half only this layer can add.
    expect(onUncaught.mock.calls[0]?.[0]).toBe(
      "Tool \"lookup_note\" threw: Cannot read properties of undefined (reading 'slice')",
    );
  });

  test("onUncaught does NOT fire for a RETURNED ToolFailure — that is the author saying 'expected'", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({ execute: () => ({ error: "The notes service answered 404." }) });
    await run("lookup_note", {}, tool, { onUncaught });
    expect(onUncaught).not.toHaveBeenCalled();
  });

  test("the model still gets the failure — reporting is additive, not a diversion", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
    });
    const result = await run("t", {}, tool, { onUncaught });
    expect(result).toContain("boom");
    expect(onUncaught).toHaveBeenCalled();
  });

  test("a throw with no onUncaught still returns the failure", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
    });
    await expect(run("t", {}, tool)).resolves.toContain("boom");
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
      execute: (_args, ctx) => {
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
        execute: (_args, ctx) => {
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
    const tool = makeTool({ execute: (_args, ctx) => String(ctx.signal !== undefined) });
    expect(await run("probe", {}, tool)).toBe("true");
  });

  test("a pre-aborted signal short-circuits before the tool runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(() => "should not run");
    const result = await run("skip", {}, makeTool({ execute }), { signal: controller.signal });
    expect(JSON.parse(result)).toMatchObject({
      error: expect.stringContaining("cancelled before it ran"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("aborting mid-flight settles a hung tool with a tool error", async () => {
    const controller = new AbortController();
    let started = false;
    const tool = makeTool({
      execute: () => {
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
