// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  buildMiddlewareRunner,
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
  runInputFilters,
  runOutputFilters,
  runToolCallInterceptors,
} from "./middleware.ts";
import type { HookContext, Middleware } from "./types.ts";

function makeCtx(
  state: Record<string, unknown> = {},
  extra: Partial<HookContext> = {},
): HookContext {
  return {
    env: {},
    state,
    sessionId: "test-session",
    kv: {} as never,
    fetch: globalThis.fetch,
    ...extra,
  };
}

describe("runBeforeTurnMiddleware", () => {
  test("returns undefined when no middleware blocks", async () => {
    const mw: Middleware[] = [
      { name: "logger", beforeTurn: vi.fn() },
      { name: "analytics", beforeTurn: vi.fn() },
    ];
    const result = await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBeUndefined();
  });

  test("returns block result when middleware blocks", async () => {
    const mw: Middleware[] = [
      {
        name: "blocker",
        beforeTurn: () => ({ block: true as const, reason: "rate limited" }),
      },
      { name: "should-not-run", beforeTurn: vi.fn() },
    ];
    const result = await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(result).toEqual({ block: true, reason: "rate limited" });
    expect(mw[1]?.beforeTurn).not.toHaveBeenCalled();
  });

  test("runs middleware in order", async () => {
    const order: string[] = [];
    const mw: Middleware[] = [
      { name: "first", beforeTurn: () => void order.push("first") },
      { name: "second", beforeTurn: () => void order.push("second") },
    ];
    await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(order).toEqual(["first", "second"]);
  });

  test("skips middleware without beforeTurn", async () => {
    const mw: Middleware[] = [{ name: "no-hook" }, { name: "has-hook", beforeTurn: vi.fn() }];
    await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(mw[1]?.beforeTurn).toHaveBeenCalledOnce();
  });
});

describe("runInputFilters", () => {
  test("pipes text through filters in order", async () => {
    const mw: Middleware[] = [
      { name: "upper", beforeInput: (ctx) => (ctx.text ?? "").toUpperCase() },
      { name: "trim", beforeInput: (ctx) => (ctx.text ?? "").trim() },
    ];
    const result = await runInputFilters(mw, makeCtx({}, { text: "  hello  " }));
    expect(result).toBe("HELLO");
  });

  test("returns original text when no filters", async () => {
    const result = await runInputFilters([], makeCtx({}, { text: "hello" }));
    expect(result).toBe("hello");
  });

  test("PII redaction pattern for input", async () => {
    const mw: Middleware[] = [
      {
        name: "pii-input",
        beforeInput: (ctx) =>
          (ctx.text ?? "").replace(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, "[SSN REDACTED]"),
      },
    ];
    const result = await runInputFilters(mw, makeCtx({}, { text: "My SSN is 123-45-6789" }));
    expect(result).toBe("My SSN is [SSN REDACTED]");
  });

  test("skips middleware without beforeInput", async () => {
    const mw: Middleware[] = [
      { name: "no-filter" },
      { name: "has-filter", beforeInput: (ctx) => `[${ctx.text}]` },
    ];
    const result = await runInputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBe("[hello]");
  });

  test("supports async input filters", async () => {
    const mw: Middleware[] = [
      {
        name: "async-filter",
        beforeInput: async (ctx) => {
          await new Promise((r) => setTimeout(r, 1));
          return (ctx.text ?? "").replace(
            /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
            "[EMAIL]",
          );
        },
      },
    ];
    const result = await runInputFilters(mw, makeCtx({}, { text: "email me at test@example.com" }));
    expect(result).toBe("email me at [EMAIL]");
  });

  test("multiple input filters chain correctly", async () => {
    const mw: Middleware[] = [
      {
        name: "redact-ssn",
        beforeInput: (ctx) => (ctx.text ?? "").replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]"),
      },
      {
        name: "redact-email",
        beforeInput: (ctx) => (ctx.text ?? "").replace(/\b\S+@\S+\.\S+\b/g, "[EMAIL]"),
      },
    ];
    const result = await runInputFilters(
      mw,
      makeCtx({}, { text: "SSN 123-45-6789 email user@test.com" }),
    );
    expect(result).toBe("SSN [SSN] email [EMAIL]");
  });

  test("beforeInput runs before beforeTurn sees the text", async () => {
    const seenByBeforeTurn: string[] = [];
    const mw: Middleware[] = [
      {
        name: "redactor",
        beforeInput: (ctx) => (ctx.text ?? "").replace(/secret/g, "[REDACTED]"),
        beforeTurn: (ctx) => {
          seenByBeforeTurn.push(ctx.text ?? "");
        },
      },
    ];
    const filtered = await runInputFilters(mw, makeCtx({}, { text: "the secret code" }));
    expect(filtered).toBe("the [REDACTED] code");
    // Simulate the session flow: beforeTurn receives the filtered text
    await runBeforeTurnMiddleware(mw, makeCtx({}, { text: filtered }));
    expect(seenByBeforeTurn).toEqual(["the [REDACTED] code"]);
  });
});

describe("runAfterTurnMiddleware", () => {
  test("runs middleware in reverse order", async () => {
    const order: string[] = [];
    const mw: Middleware[] = [
      { name: "first", afterTurn: () => void order.push("first") },
      { name: "second", afterTurn: () => void order.push("second") },
    ];
    await runAfterTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(order).toEqual(["second", "first"]);
  });
});

describe("runToolCallInterceptors", () => {
  test("returns undefined when no interceptors act", async () => {
    const mw: Middleware[] = [{ name: "logger", beforeToolCall: vi.fn() }];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toBeUndefined();
  });

  test("blocks tool call", async () => {
    const mw: Middleware[] = [
      {
        name: "blocker",
        beforeToolCall: () => ({ block: true as const, reason: "denied" }),
      },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toEqual({ type: "block", reason: "denied" });
  });

  test("returns cached result", async () => {
    const mw: Middleware[] = [
      {
        name: "cache",
        beforeToolCall: () => ({ result: "cached" }),
      },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toEqual({ type: "result", result: "cached" });
  });

  test("transforms args", async () => {
    const mw: Middleware[] = [
      {
        name: "transformer",
        beforeToolCall: (ctx) => ({
          args: { ...ctx.args, extra: true },
        }),
      },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: { a: 1 } }));
    expect(result).toEqual({ type: "args", args: { a: 1, extra: true } });
  });

  test("chains arg transforms across middleware", async () => {
    const mw: Middleware[] = [
      {
        name: "add-x",
        beforeToolCall: (ctx) => ({
          args: { ...ctx.args, x: 1 },
        }),
      },
      {
        name: "add-y",
        beforeToolCall: (ctx) => ({
          args: { ...ctx.args, y: 2 },
        }),
      },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toEqual({ type: "args", args: { x: 1, y: 2 } });
  });
});

describe("runAfterToolCallMiddleware", () => {
  test("runs in reverse order", async () => {
    const order: string[] = [];
    const mw: Middleware[] = [
      { name: "first", afterToolCall: () => void order.push("first") },
      { name: "second", afterToolCall: () => void order.push("second") },
    ];
    await runAfterToolCallMiddleware(mw, makeCtx({}, { tool: "tool", args: {}, result: "result" }));
    expect(order).toEqual(["second", "first"]);
  });

  test("receives tool, args, and result on ctx", async () => {
    const fn = vi.fn();
    const mw: Middleware[] = [{ name: "logger", afterToolCall: fn }];
    await runAfterToolCallMiddleware(
      mw,
      makeCtx({}, { tool: "search", args: { q: "test" }, result: "found" }),
    );
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "search", args: { q: "test" }, result: "found" }),
    );
  });

  test("skips middleware without afterToolCall", async () => {
    const fn = vi.fn();
    const mw: Middleware[] = [{ name: "no-hook" }, { name: "has-hook", afterToolCall: fn }];
    await runAfterToolCallMiddleware(mw, makeCtx({}, { tool: "tool", args: {}, result: "result" }));
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("runOutputFilters", () => {
  test("pipes text through filters in order", async () => {
    const mw: Middleware[] = [
      { name: "upper", beforeOutput: (ctx) => (ctx.text ?? "").toUpperCase() },
      { name: "trim", beforeOutput: (ctx) => (ctx.text ?? "").trim() },
    ];
    const result = await runOutputFilters(mw, makeCtx({}, { text: "  hello  " }));
    expect(result).toBe("HELLO");
  });

  test("returns original text when no filters", async () => {
    const result = await runOutputFilters([], makeCtx({}, { text: "hello" }));
    expect(result).toBe("hello");
  });

  test("PII redaction pattern", async () => {
    const mw: Middleware[] = [
      {
        name: "pii",
        beforeOutput: (ctx) =>
          (ctx.text ?? "").replace(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, "[SSN REDACTED]"),
      },
    ];
    const result = await runOutputFilters(mw, makeCtx({}, { text: "SSN is 123-45-6789" }));
    expect(result).toBe("SSN is [SSN REDACTED]");
  });

  test("skips middleware without beforeOutput", async () => {
    const mw: Middleware[] = [
      { name: "no-filter" },
      { name: "has-filter", beforeOutput: (ctx) => `[${ctx.text}]` },
    ];
    const result = await runOutputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBe("[hello]");
  });

  test("supports async output filters", async () => {
    const mw: Middleware[] = [
      {
        name: "async-filter",
        beforeOutput: async (ctx) => {
          await new Promise((r) => setTimeout(r, 1));
          return (ctx.text ?? "").toUpperCase();
        },
      },
    ];
    const result = await runOutputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBe("HELLO");
  });
});

describe("middleware state access", () => {
  test("beforeTurn can read and mutate state", async () => {
    const state = { count: 0 };
    const mw: Middleware[] = [
      {
        name: "counter",
        beforeTurn: (ctx): undefined => {
          ctx.state.count++;
        },
      },
    ];
    await runBeforeTurnMiddleware(mw, makeCtx(state, { text: "hello" }));
    expect(state.count).toBe(1);
  });

  test("afterTurn can access state", async () => {
    const state = { turns: 0 };
    const mw: Middleware[] = [
      {
        name: "counter",
        afterTurn: (ctx) => {
          ctx.state.turns++;
        },
      },
    ];
    await runAfterTurnMiddleware(mw, makeCtx(state, { text: "hello" }));
    expect(state.turns).toBe(1);
  });

  test("beforeToolCall can access state for caching", async () => {
    const state = { cache: { "tool:{}": "cached-result" } };
    const mw: Middleware[] = [
      {
        name: "cache",
        beforeToolCall: (ctx) => {
          const key = `${ctx.tool}:${JSON.stringify(ctx.args)}`;
          if (ctx.state.cache[key]) return { result: ctx.state.cache[key] };
        },
      },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx(state, { tool: "tool", args: {} }));
    expect(result).toEqual({ type: "result", result: "cached-result" });
  });

  test("state-agnostic Middleware works in typed Middleware<S> array", () => {
    type AppState = { counter: number };

    // Reusable middleware — no generic needed
    const logger: Middleware = {
      name: "logger",
      beforeTurn: (ctx) => {
        console.log(ctx.text);
      },
    };

    // State-aware middleware
    const counter: Middleware<AppState> = {
      name: "counter",
      beforeTurn: (ctx) => {
        ctx.state.counter++;
      },
    };

    // Both should be assignable to the same typed array
    const mws: Middleware<AppState>[] = [logger, counter];
    expect(mws).toHaveLength(2);
  });
});

describe("middleware composition edge cases", () => {
  test("empty middleware array is a no-op for beforeTurn", async () => {
    const result = await runBeforeTurnMiddleware([], makeCtx({}, { text: "hello" }));
    expect(result).toBeUndefined();
  });

  test("empty middleware array is a no-op for afterTurn", async () => {
    await runAfterTurnMiddleware([], makeCtx({}, { text: "hello" }));
  });

  test("empty middleware array is a no-op for beforeToolCalls", async () => {
    const result = await runToolCallInterceptors([], makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toBeUndefined();
  });

  test("block in second middleware prevents third from running", async () => {
    const third = vi.fn();
    const mw: Middleware[] = [
      { name: "first", beforeToolCall: vi.fn() },
      {
        name: "blocker",
        beforeToolCall: () => ({ block: true as const, reason: "stop" }),
      },
      { name: "third", beforeToolCall: third },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toEqual({ type: "block", reason: "stop" });
    expect(third).not.toHaveBeenCalled();
  });

  test("cached result in first middleware prevents second from running", async () => {
    const second = vi.fn();
    const mw: Middleware[] = [
      {
        name: "cache",
        beforeToolCall: () => ({ result: "fast" }),
      },
      { name: "second", beforeToolCall: second },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toEqual({ type: "result", result: "fast" });
    expect(second).not.toHaveBeenCalled();
  });

  test("async beforeTurn middleware works", async () => {
    const mw: Middleware[] = [
      {
        name: "async-check",
        beforeTurn: async () => {
          await new Promise((r) => setTimeout(r, 1));
          return { block: true as const, reason: "async block" };
        },
      },
    ];
    const result = await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(result).toEqual({ block: true, reason: "async block" });
  });

  test("multiple output filters chain correctly", async () => {
    const mw: Middleware[] = [
      {
        name: "redact-ssn",
        beforeOutput: (ctx) => (ctx.text ?? "").replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]"),
      },
      {
        name: "redact-email",
        beforeOutput: (ctx) => (ctx.text ?? "").replace(/\b\S+@\S+\.\S+\b/g, "[EMAIL]"),
      },
      { name: "wrap", beforeOutput: (ctx) => `filtered: ${ctx.text}` },
    ];
    const result = await runOutputFilters(
      mw,
      makeCtx({}, { text: "Contact john@example.com, SSN 123-45-6789" }),
    );
    expect(result).toBe("filtered: Contact [EMAIL], SSN [SSN]");
  });
});

// ─── Error handling behavior (Issue #8) ──────────────────────────────────────

describe("middleware error propagation (fail-open)", () => {
  test("beforeTurn: throwing middleware is caught and continues", async () => {
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeTurn: () => {
          throw new Error("boom");
        },
      },
    ];
    const result = await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBeUndefined();
  });

  test("beforeTurn: throwing middleware does not prevent subsequent middleware", async () => {
    const second = vi.fn();
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeTurn: () => {
          throw new Error("boom");
        },
      },
      { name: "second", beforeTurn: second },
    ];
    await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(second).toHaveBeenCalled();
  });

  test("afterTurn: throwing middleware is caught and continues", async () => {
    const mw: Middleware[] = [
      {
        name: "thrower",
        afterTurn: () => {
          throw new Error("afterTurn boom");
        },
      },
    ];
    await expect(
      runAfterTurnMiddleware(mw, makeCtx({}, { text: "hello" })),
    ).resolves.toBeUndefined();
  });

  test("afterTurn: throwing middleware does not prevent subsequent (earlier-order) middleware", async () => {
    const first = vi.fn();
    const mw: Middleware[] = [
      { name: "first", afterTurn: first },
      {
        name: "thrower",
        afterTurn: () => {
          throw new Error("boom");
        },
      },
    ];
    // afterTurn runs in reverse, so "thrower" (index 1) runs first
    await runAfterTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(first).toHaveBeenCalled();
  });

  test("beforeToolCall: throwing middleware is caught and continues", async () => {
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeToolCall: () => {
          throw new Error("intercept boom");
        },
      },
    ];
    const result = await runToolCallInterceptors(mw, makeCtx({}, { tool: "tool", args: {} }));
    expect(result).toBeUndefined();
  });

  test("beforeInput: throwing filter is caught, original text preserved", async () => {
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeInput: () => {
          throw new Error("input filter boom");
        },
      },
    ];
    const result = await runInputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBe("hello");
  });

  test("beforeInput: throwing filter does not prevent subsequent filters", async () => {
    const second = vi.fn().mockReturnValue("filtered");
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeInput: () => {
          throw new Error("input filter boom");
        },
      },
      { name: "second", beforeInput: second },
    ];
    const result = await runInputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(second).toHaveBeenCalled();
    expect(result).toBe("filtered");
  });

  test("beforeOutput: throwing filter is caught, original text preserved", async () => {
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeOutput: () => {
          throw new Error("filter boom");
        },
      },
    ];
    const result = await runOutputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(result).toBe("hello");
  });

  test("beforeOutput: throwing filter does not prevent subsequent filters", async () => {
    const second = vi.fn().mockReturnValue("filtered");
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeOutput: () => {
          throw new Error("filter boom");
        },
      },
      { name: "second", beforeOutput: second },
    ];
    const result = await runOutputFilters(mw, makeCtx({}, { text: "hello" }));
    expect(second).toHaveBeenCalled();
    expect(result).toBe("filtered");
  });

  test("afterToolCall: throwing middleware is caught and continues", async () => {
    const mw: Middleware[] = [
      {
        name: "thrower",
        afterToolCall: () => {
          throw new Error("afterTool boom");
        },
      },
    ];
    await expect(
      runAfterToolCallMiddleware(mw, makeCtx({}, { tool: "tool", args: {}, result: "result" })),
    ).resolves.toBeUndefined();
  });
});

// ─── onError callback ──────────────────────────────────────────────────────────

describe("onError callback", () => {
  test("runner functions call onError with middleware name, hook, and error", async () => {
    const onError = vi.fn();
    const boom = new Error("boom");
    const mw: Middleware[] = [
      {
        name: "guardrail",
        beforeInput: () => {
          throw boom;
        },
      },
    ];
    await runInputFilters(mw, makeCtx({}, { text: "hello" }), onError);
    expect(onError).toHaveBeenCalledWith({
      middleware: "guardrail",
      hook: "beforeInput",
      error: boom,
    });
  });

  test("onError receives correct hook name for each phase", async () => {
    const onError = vi.fn();
    const thrower: Middleware = {
      name: "bad-mw",
      beforeInput: () => {
        throw new Error("1");
      },
      beforeTurn: () => {
        throw new Error("2");
      },
      afterTurn: () => {
        throw new Error("3");
      },
      beforeToolCall: () => {
        throw new Error("4");
      },
      afterToolCall: () => {
        throw new Error("5");
      },
      beforeOutput: () => {
        throw new Error("6");
      },
    };
    const mw = [thrower];
    await runInputFilters(mw, makeCtx({}, { text: "" }), onError);
    await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "" }), onError);
    await runAfterTurnMiddleware(mw, makeCtx({}, { text: "" }), onError);
    await runToolCallInterceptors(mw, makeCtx({}, { tool: "t", args: {} }), onError);
    await runAfterToolCallMiddleware(mw, makeCtx({}, { tool: "t", args: {}, result: "" }), onError);
    await runOutputFilters(mw, makeCtx({}, { text: "" }), onError);

    // biome-ignore lint/suspicious/noExplicitAny: test helper
    const hooks = onError.mock.calls.map((c: any) => c[0].hook);
    expect(hooks).toEqual([
      "beforeInput",
      "beforeTurn",
      "afterTurn",
      "beforeToolCall",
      "afterToolCall",
      "beforeOutput",
    ]);
  });

  test("buildMiddlewareRunner threads onError to all hooks", async () => {
    const onError = vi.fn();
    const mw: Middleware[] = [
      {
        name: "failing-guardrail",
        beforeInput: () => {
          throw new Error("filter fail");
        },
        beforeOutput: () => {
          throw new Error("output fail");
        },
      },
    ];
    // biome-ignore lint/style/noNonNullAssertion: non-empty middleware guarantees defined runner
    const runner = buildMiddlewareRunner(mw, () => makeCtx(), onError)!;
    await runner.filterInput("s1", "hi");
    await runner.filterOutput("s1", "bye");
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0].hook).toBe("beforeInput");
    expect(onError.mock.calls[1]?.[0].hook).toBe("beforeOutput");
  });

  test("default onError uses console.warn", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mw: Middleware[] = [
      {
        name: "thrower",
        beforeTurn: () => {
          throw new Error("boom");
        },
      },
    ];
    await runBeforeTurnMiddleware(mw, makeCtx({}, { text: "hello" }));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("thrower");
    expect(spy.mock.calls[0]?.[0]).toContain("beforeTurn");
    spy.mockRestore();
  });
});
