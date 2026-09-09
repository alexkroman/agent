// Copyright 2025 the AAI authors. MIT license.

import type { ToolDef } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai/utils";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createScriptedOneShotModel, registerFakeProviders } from "./_pipeline-test-fakes.ts";
import { makeTool, malformedOnError, sleep } from "./_test-utils.ts";
import { createGenerateFn } from "./generate.ts";
import { executeToolCall, type FatalToolError, isFatalToolError } from "./tool-executor.ts";
import { createUsageMeter, type UsageSnapshot } from "./usage-meter.ts";

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

  test("ctx.deadlineAt is THIS call's deadline, and follows a custom timeoutMs", async () => {
    // The value a tool budgets against. It is per-call rather than the constant
    // — `createTextAgent` passes its own `timeoutMs` — which is the whole
    // reason this is on the context and not an exported number.
    let seen = 0;
    const tool = makeTool({
      execute: (_args, ctx) => {
        seen = ctx.deadlineAt;
        return "ok";
      },
    });

    const before = Date.now();
    await run("t", {}, tool);
    // The default 30s window, allowing for the clock moving during the call.
    expect(seen).toBeGreaterThanOrEqual(before + 30_000 - 50);
    expect(seen).toBeLessThanOrEqual(Date.now() + 30_000);

    const custom = Date.now();
    await run("t", {}, tool, { timeoutMs: 5000 });
    expect(seen).toBeGreaterThanOrEqual(custom + 5000 - 50);
    expect(seen).toBeLessThanOrEqual(Date.now() + 5000);
  });

  test("a tool can answer BEFORE its deadline by reading it", async () => {
    // The case the field exists for: the alternative is being cut off with
    // `Tool "..." timed out after Nms` and nothing else reaching the model.
    const tool = makeTool({
      execute: async (_args, ctx) => {
        const budget = ctx.deadlineAt - Date.now() - 40;
        await sleep(Math.max(0, budget));
        return "partial answer";
      },
    });
    expect(await run("t", {}, tool, { timeoutMs: 120 })).toBe("partial answer");
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

describe("executeToolCall — onError classifies a THROW", () => {
  // The gap this closes: without `onError` every exception reaches the model as
  // an ordinary tool result, so a bad credential, a TypeError and a deliberate
  // toolFailure() are one thing as far as the model can tell — and it retries a
  // permanently broken tool until the reply's maxSteps budget burns.

  test("no onError: a throw is still the model's result, unchanged", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
    });
    const result = await run("t", {}, tool, { onUncaught });
    expect(JSON.parse(result)).toEqual({ error: "boom" });
    expect(onUncaught).toHaveBeenCalledWith('Tool "t" threw: boom', { fatal: false });
  });

  test("no onError: a RETURNED ToolFailure is unchanged too", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({ execute: () => toolFailure("No order A1.") });
    const result = await run("t", {}, tool, { onUncaught });
    expect(JSON.parse(result)).toEqual({ error: "No order A1." });
    expect(onUncaught).not.toHaveBeenCalled();
  });

  test("a RETURNED ToolFailure never reaches onError — that channel is already the author's", async () => {
    const onError = vi.fn(() => toolFailure("handled"));
    const tool = makeTool({ execute: () => toolFailure("No order A1."), onError });
    expect(JSON.parse(await run("t", {}, tool))).toEqual({ error: "No order A1." });
    expect(onError).not.toHaveBeenCalled();
  });

  test("onError returning a ToolFailure: that is what the model gets, and it is not reported", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({
      execute: () => {
        throw new Error("ECONNRESET");
      },
      onError: () => toolFailure("The orders service is unavailable right now."),
    });
    const result = await run("lookup_order", {}, tool, { onUncaught });
    expect(JSON.parse(result)).toEqual({ error: "The orders service is unavailable right now." });
    // Handled is handled: the same silence a RETURNED failure gets.
    expect(onUncaught).not.toHaveBeenCalled();
  });

  test("onError returning a string: sent verbatim, like any string result", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("nope");
      },
      onError: () => "Nothing found; ask the caller for the order number.",
    });
    expect(await run("lookup_order", {}, tool)).toBe(
      "Nothing found; ask the caller for the order number.",
    );
  });

  test("onError is handed the error and the same ctx execute ran with", async () => {
    const seen: { err?: unknown; env?: unknown; sessionId?: unknown } = {};
    const cause = new Error("ORDERS_API_KEY is unset");
    const tool = makeTool({
      execute: () => {
        throw cause;
      },
      onError: (err, ctx) => {
        seen.err = err;
        seen.env = ctx.env;
        seen.sessionId = ctx.sessionId;
        return toolFailure("handled");
      },
    });
    await run("lookup_order", {}, tool, { env: { ORDERS_API: "x" }, sessionId: "s1" });
    expect(seen.err).toBe(cause);
    expect(seen.env).toEqual({ ORDERS_API: "x" });
    expect(seen.sessionId).toBe("s1");
  });

  test("onError RETHROWING is fatal: the call rejects, so the model gets nothing to retry against", async () => {
    const onUncaught = vi.fn();
    const cause = new Error("ORDERS_API_KEY is unset");
    const tool = makeTool({
      execute: () => {
        throw cause;
      },
      onError: (err) => {
        throw err;
      },
    });
    const failure = await run("lookup_order", {}, tool, { onUncaught }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isFatalToolError(failure)).toBe(true);
    expect((failure as FatalToolError).toolName).toBe("lookup_order");
    expect((failure as FatalToolError).cause).toBe(cause);
    expect((failure as Error).message).toBe(
      'Tool "lookup_order" failed fatally: ORDERS_API_KEY is unset',
    );
    // The rejection is invisible to the model by design, so the report is the
    // only trace — and it says which of the two throws this was.
    expect(onUncaught).toHaveBeenCalledWith(
      'Tool "lookup_order" failed fatally: ORDERS_API_KEY is unset',
      { fatal: true },
    );
  });

  test("a fatal call logs at error level, not warn", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tool = makeTool({
      execute: () => {
        throw new Error("no key");
      },
      onError: (err) => {
        throw err;
      },
    });
    await expect(run("t", {}, tool, { logger })).rejects.toThrow(/failed fatally/);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a handler that throws for its OWN reason is fatal too", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("upstream");
      },
      onError: () => {
        throw new TypeError("cannot read properties of undefined");
      },
    });
    const failure = await run("t", {}, tool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isFatalToolError(failure)).toBe(true);
    expect((failure as FatalToolError).cause).toBeInstanceOf(TypeError);
  });

  test("onError returning undefined falls through to the default", async () => {
    const onUncaught = vi.fn();
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
      // A handler written to observe and nothing else. Stringifying its
      // `undefined` would hand the model the string "null" as the result.
      onError: malformedOnError(() => undefined),
    });
    const result = await run("t", {}, tool, { onUncaught });
    expect(JSON.parse(result)).toEqual({ error: "boom" });
    expect(onUncaught).toHaveBeenCalledWith('Tool "t" threw: boom', { fatal: false });
  });

  test("an async onError is refused, fatally — the promise would serialize as {}", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
      onError: malformedOnError(() => Promise.resolve(toolFailure("late"))),
    });
    const failure = await run("t", {}, tool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isFatalToolError(failure)).toBe(true);
    expect((failure as Error).message).toContain("returned a promise");
  });

  test("a CANCELLED call never reaches onError — an interruption is not a tool fault", async () => {
    const onError = vi.fn(() => {
      throw new Error("would be fatal");
    });
    const controller = new AbortController();
    let started = false;
    const tool = makeTool({
      execute: () => {
        started = true;
        return new Promise<never>(() => {
          /* never resolves */
        });
      },
      onError,
    });
    const promise = run("hang", {}, tool, { signal: controller.signal, onError });
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    // Settles with the ordinary cancellation failure rather than rejecting.
    expect(JSON.parse(await promise)).toMatchObject({ error: expect.stringMatching(/abort/i) });
    expect(onError).not.toHaveBeenCalled();
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

describe("executeToolCall — a result larger than MAX_TOOL_RESULT_CHARS", () => {
  // The documented cap is a CLIENT cap. `ToolDef.execute` and the tools page
  // both promised it applied "for the LLM and the client", so an unshaped
  // `await res.json()` read as free — while what actually happens is that the
  // whole string is appended to the conversation and re-sent on every later
  // turn of the call. Nothing said so anywhere, which is what these tests are
  // for: the size stays uncapped (changing that is a behaviour decision), and
  // the warning is what makes it visible.
  const big = (n: number) => "x".repeat(n);

  test("the provider's copy is NOT capped — the model gets the whole result", async () => {
    const tool = makeTool({ execute: () => big(9000) });
    const result = await run("fetch_report", {}, tool);
    expect(result).toHaveLength(9000);
    expect(result).not.toContain("[truncated]");
  });

  test("warns once, naming the tool and the size", async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const tool = makeTool({ execute: () => big(9000) });
    // A distinct name per test: the once-latch is process-wide (one agent per
    // process), so a shared name would make this assertion depend on order.
    await run("oversized_once", {}, tool, { logger });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] ?? [];
    expect(message).toContain('"oversized_once"');
    expect(message).toContain("9000 characters");
    expect(message).toContain("MAX_TOOL_RESULT_CHARS");
    expect(fields).toMatchObject({ tool: "oversized_once", chars: 9000 });

    // Second call, same tool: one line per process, not one per turn.
    await run("oversized_once", {}, tool, { logger });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("says nothing about a result inside the cap", async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    await run("small_result", {}, makeTool({ execute: () => big(3999) }), { logger });
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * What a tool's OWN model calls cost, and who is told.
 *
 * `ctx.generate` is a real model request on the session's bill, and the meter
 * shipped fed by the conversational loop alone — so an agent that reasons
 * inside a tool (a planner re-planning, a grader scoring) reported none of it
 * on `usage.updated` and could blow a `usageLimits.totalTokens` budget without
 * the budget noticing. These are the specs whose absence let that ship: they
 * drive the REAL `createGenerateFn` through the real forwarder, because a spec
 * asserting on the meter directly would have passed against the broken wiring.
 */
describe("ctx.generate spends on the session's meter", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  /** The real host `ctx.generate` over a fake model that reports 2 tokens a call. */
  function generating() {
    const model = createScriptedOneShotModel([{ text: "first" }, { text: "second" }]);
    const fakes = registerFakeProviders({ llm: model });
    unregister = fakes.unregister;
    if (!fakes.llm) throw new Error("fake llm descriptor missing");
    return { model, generate: createGenerateFn({ llm: fakes.llm, env: fakes.env }) };
  }

  /** A tool whose whole body is one generation — the shape the defect was found in. */
  const asking = makeTool({
    execute: async (_args, ctx) => (await ctx.generate({ prompt: "summarize" })).text,
  });

  test("one generation from a tool body moves the meter", async () => {
    const { generate } = generating();
    const updates: UsageSnapshot[] = [];
    const usage = createUsageMeter({ onUpdate: (snapshot) => updates.push(snapshot) });

    expect(await run("ask", {}, asking, { generate, usage })).toBe("first");

    expect(usage.snapshot()).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, steps: 1 });
    // Announced, not merely accumulated: `usage.updated` is how an author sees
    // a tool's spend at all, and it is emitted off this callback.
    expect(updates).toHaveLength(1);
  });

  test("a generation past the cap is REFUSED, and the model is never dialled", async () => {
    const { model, generate } = generating();
    const usage = createUsageMeter({ limits: { totalTokens: 2 }, onUpdate: () => undefined });

    // The first call reaches the cap; the rule is that the request in flight
    // finishes and the NEXT one is refused, so this one answers.
    expect(await run("ask", {}, asking, { generate, usage })).toBe("first");
    expect(usage.exhausted()).toBeDefined();

    const refused = await run("ask", {}, asking, { generate, usage });
    // The tool did not handle the rejection, so the executor serialized it —
    // which is the shape the model reads and can say something true about.
    expect(JSON.parse(refused).error).toContain("usageLimits.totalTokens");
    // The check is BEFORE the request, so the refusal costs nothing.
    expect(model.calls).toHaveLength(1);
  });

  test("no meter means uncounted, never refused — a sessionless caller still generates", async () => {
    const { generate } = generating();
    expect(await run("ask", {}, asking, { generate })).toBe("first");
  });
});
