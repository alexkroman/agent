// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
  runInputFilters,
  runOutputFilters,
  runToolCallInterceptors,
} from "./middleware.ts";
import type { HookContext, Middleware } from "./types.ts";

function makeCtx(state: Record<string, unknown> = {}): HookContext {
  return {
    env: {},
    state,
    kv: {} as never,
    vector: {} as never,
    fetch: globalThis.fetch,
  };
}

describe("runBeforeTurnMiddleware", () => {
  test("returns undefined when no middleware blocks", async () => {
    const mw: Middleware[] = [
      { name: "logger", beforeTurn: vi.fn() },
      { name: "analytics", beforeTurn: vi.fn() },
    ];
    const result = await runBeforeTurnMiddleware(mw, "hello", makeCtx());
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
    const result = await runBeforeTurnMiddleware(mw, "hello", makeCtx());
    expect(result).toEqual({ block: true, reason: "rate limited" });
    expect(mw[1]?.beforeTurn).not.toHaveBeenCalled();
  });

  test("runs middleware in order", async () => {
    const order: string[] = [];
    const mw: Middleware[] = [
      { name: "first", beforeTurn: () => void order.push("first") },
      { name: "second", beforeTurn: () => void order.push("second") },
    ];
    await runBeforeTurnMiddleware(mw, "hello", makeCtx());
    expect(order).toEqual(["first", "second"]);
  });

  test("skips middleware without beforeTurn", async () => {
    const mw: Middleware[] = [{ name: "no-hook" }, { name: "has-hook", beforeTurn: vi.fn() }];
    await runBeforeTurnMiddleware(mw, "hello", makeCtx());
    expect(mw[1]?.beforeTurn).toHaveBeenCalledOnce();
  });
});

describe("runInputFilters", () => {
  test("pipes text through filters in order", async () => {
    const mw: Middleware[] = [
      { name: "upper", beforeInput: (text) => text.toUpperCase() },
      { name: "trim", beforeInput: (text) => text.trim() },
    ];
    const result = await runInputFilters(mw, "  hello  ", makeCtx());
    expect(result).toBe("HELLO");
  });

  test("returns original text when no filters", async () => {
    const result = await runInputFilters([], "hello", makeCtx());
    expect(result).toBe("hello");
  });

  test("PII redaction pattern for input", async () => {
    const mw: Middleware[] = [
      {
        name: "pii-input",
        beforeInput: (text) => text.replace(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, "[SSN REDACTED]"),
      },
    ];
    const result = await runInputFilters(mw, "My SSN is 123-45-6789", makeCtx());
    expect(result).toBe("My SSN is [SSN REDACTED]");
  });

  test("skips middleware without beforeInput", async () => {
    const mw: Middleware[] = [
      { name: "no-filter" },
      { name: "has-filter", beforeInput: (text) => `[${text}]` },
    ];
    const result = await runInputFilters(mw, "hello", makeCtx());
    expect(result).toBe("[hello]");
  });

  test("supports async input filters", async () => {
    const mw: Middleware[] = [
      {
        name: "async-filter",
        beforeInput: async (text) => {
          await new Promise((r) => setTimeout(r, 1));
          return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]");
        },
      },
    ];
    const result = await runInputFilters(mw, "email me at test@example.com", makeCtx());
    expect(result).toBe("email me at [EMAIL]");
  });

  test("multiple input filters chain correctly", async () => {
    const mw: Middleware[] = [
      { name: "redact-ssn", beforeInput: (t) => t.replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]") },
      { name: "redact-email", beforeInput: (t) => t.replace(/\b\S+@\S+\.\S+\b/g, "[EMAIL]") },
    ];
    const result = await runInputFilters(mw, "SSN 123-45-6789 email user@test.com", makeCtx());
    expect(result).toBe("SSN [SSN] email [EMAIL]");
  });

  test("beforeInput runs before beforeTurn sees the text", async () => {
    const seenByBeforeTurn: string[] = [];
    const mw: Middleware[] = [
      {
        name: "redactor",
        beforeInput: (text) => text.replace(/secret/g, "[REDACTED]"),
        beforeTurn: (text) => {
          seenByBeforeTurn.push(text);
        },
      },
    ];
    const filtered = await runInputFilters(mw, "the secret code", makeCtx());
    expect(filtered).toBe("the [REDACTED] code");
    // Simulate the session flow: beforeTurn receives the filtered text
    await runBeforeTurnMiddleware(mw, filtered, makeCtx());
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
    await runAfterTurnMiddleware(mw, "hello", makeCtx());
    expect(order).toEqual(["second", "first"]);
  });
});

describe("runToolCallInterceptors", () => {
  test("returns undefined when no interceptors act", async () => {
    const mw: Middleware[] = [{ name: "logger", beforeToolCall: vi.fn() }];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
    expect(result).toBeUndefined();
  });

  test("blocks tool call", async () => {
    const mw: Middleware[] = [
      {
        name: "blocker",
        beforeToolCall: () => ({ block: true as const, reason: "denied" }),
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
    expect(result).toEqual({ type: "block", reason: "denied" });
  });

  test("returns cached result", async () => {
    const mw: Middleware[] = [
      {
        name: "cache",
        beforeToolCall: () => ({ result: "cached" }),
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
    expect(result).toEqual({ type: "result", result: "cached" });
  });

  test("transforms args", async () => {
    const mw: Middleware[] = [
      {
        name: "transformer",
        beforeToolCall: (_name, args) => ({
          args: { ...args, extra: true },
        }),
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", { a: 1 }, makeCtx());
    expect(result).toEqual({ type: "args", args: { a: 1, extra: true } });
  });

  test("chains arg transforms across middleware", async () => {
    const mw: Middleware[] = [
      {
        name: "add-x",
        beforeToolCall: (_name, args) => ({
          args: { ...args, x: 1 },
        }),
      },
      {
        name: "add-y",
        beforeToolCall: (_name, args) => ({
          args: { ...args, y: 2 },
        }),
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
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
    await runAfterToolCallMiddleware(mw, "tool", {}, "result", makeCtx());
    expect(order).toEqual(["second", "first"]);
  });

  test("receives tool name, args, and result", async () => {
    const fn = vi.fn();
    const mw: Middleware[] = [{ name: "logger", afterToolCall: fn }];
    await runAfterToolCallMiddleware(mw, "search", { q: "test" }, "found", makeCtx());
    expect(fn).toHaveBeenCalledWith("search", { q: "test" }, "found", expect.any(Object));
  });
});

describe("runAfterToolCallMiddleware", () => {
  test("skips middleware without afterToolCall", async () => {
    const fn = vi.fn();
    const mw: Middleware[] = [{ name: "no-hook" }, { name: "has-hook", afterToolCall: fn }];
    await runAfterToolCallMiddleware(mw, "tool", {}, "result", makeCtx());
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("runOutputFilters", () => {
  test("pipes text through filters in order", async () => {
    const mw: Middleware[] = [
      { name: "upper", beforeOutput: (text) => text.toUpperCase() },
      { name: "trim", beforeOutput: (text) => text.trim() },
    ];
    const result = await runOutputFilters(mw, "  hello  ", makeCtx());
    expect(result).toBe("HELLO");
  });

  test("returns original text when no filters", async () => {
    const result = await runOutputFilters([], "hello", makeCtx());
    expect(result).toBe("hello");
  });

  test("PII redaction pattern", async () => {
    const mw: Middleware[] = [
      {
        name: "pii",
        beforeOutput: (text) => text.replace(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, "[SSN REDACTED]"),
      },
    ];
    const result = await runOutputFilters(mw, "SSN is 123-45-6789", makeCtx());
    expect(result).toBe("SSN is [SSN REDACTED]");
  });

  test("skips middleware without beforeOutput", async () => {
    const mw: Middleware[] = [
      { name: "no-filter" },
      { name: "has-filter", beforeOutput: (text) => `[${text}]` },
    ];
    const result = await runOutputFilters(mw, "hello", makeCtx());
    expect(result).toBe("[hello]");
  });

  test("supports async output filters", async () => {
    const mw: Middleware[] = [
      {
        name: "async-filter",
        beforeOutput: async (text) => {
          await new Promise((r) => setTimeout(r, 1));
          return text.toUpperCase();
        },
      },
    ];
    const result = await runOutputFilters(mw, "hello", makeCtx());
    expect(result).toBe("HELLO");
  });
});

describe("middleware state access", () => {
  test("beforeTurn can read and mutate state", async () => {
    const state = { count: 0 };
    const mw: Middleware[] = [
      {
        name: "counter",
        beforeTurn: (_text, ctx): undefined => {
          ctx.state.count++;
        },
      },
    ];
    await runBeforeTurnMiddleware(mw, "hello", makeCtx(state));
    expect(state.count).toBe(1);
  });

  test("afterTurn can access state", async () => {
    const state = { turns: 0 };
    const mw: Middleware[] = [
      {
        name: "counter",
        afterTurn: (_text, ctx) => {
          ctx.state.turns++;
        },
      },
    ];
    await runAfterTurnMiddleware(mw, "hello", makeCtx(state));
    expect(state.turns).toBe(1);
  });

  test("beforeToolCall can access state for caching", async () => {
    const state = { cache: { "tool:{}": "cached-result" } };
    const mw: Middleware[] = [
      {
        name: "cache",
        beforeToolCall: (toolName, args, ctx) => {
          const key = `${toolName}:${JSON.stringify(args)}`;
          if (ctx.state.cache[key]) return { result: ctx.state.cache[key] };
        },
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx(state));
    expect(result).toEqual({ type: "result", result: "cached-result" });
  });

  test("state-agnostic Middleware works in typed Middleware<S> array", () => {
    type AppState = { counter: number };

    // Reusable middleware — no generic needed
    const logger: Middleware = {
      name: "logger",
      beforeTurn: (text) => {
        console.log(text);
      },
    };

    // State-aware middleware
    const counter: Middleware<AppState> = {
      name: "counter",
      beforeTurn: (_text, ctx) => {
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
    const result = await runBeforeTurnMiddleware([], "hello", makeCtx());
    expect(result).toBeUndefined();
  });

  test("empty middleware array is a no-op for afterTurn", async () => {
    await runAfterTurnMiddleware([], "hello", makeCtx());
  });

  test("empty middleware array is a no-op for beforeToolCalls", async () => {
    const result = await runToolCallInterceptors([], "tool", {}, makeCtx());
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
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
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
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
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
    const result = await runBeforeTurnMiddleware(mw, "hello", makeCtx());
    expect(result).toEqual({ block: true, reason: "async block" });
  });

  test("multiple output filters chain correctly", async () => {
    const mw: Middleware[] = [
      { name: "redact-ssn", beforeOutput: (t) => t.replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]") },
      { name: "redact-email", beforeOutput: (t) => t.replace(/\b\S+@\S+\.\S+\b/g, "[EMAIL]") },
      { name: "wrap", beforeOutput: (t) => `filtered: ${t}` },
    ];
    const result = await runOutputFilters(
      mw,
      "Contact john@example.com, SSN 123-45-6789",
      makeCtx(),
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
    const result = await runBeforeTurnMiddleware(mw, "hello", makeCtx());
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
    await runBeforeTurnMiddleware(mw, "hello", makeCtx());
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
    await expect(runAfterTurnMiddleware(mw, "hello", makeCtx())).resolves.toBeUndefined();
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
    await runAfterTurnMiddleware(mw, "hello", makeCtx());
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
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
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
    const result = await runInputFilters(mw, "hello", makeCtx());
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
    const result = await runInputFilters(mw, "hello", makeCtx());
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
    const result = await runOutputFilters(mw, "hello", makeCtx());
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
    const result = await runOutputFilters(mw, "hello", makeCtx());
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
      runAfterToolCallMiddleware(mw, "tool", {}, "result", makeCtx()),
    ).resolves.toBeUndefined();
  });
});
