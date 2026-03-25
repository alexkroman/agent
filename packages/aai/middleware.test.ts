// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
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
    const mw: Middleware[] = [{ name: "logger", toolCallInterceptor: vi.fn() }];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
    expect(result).toBeUndefined();
  });

  test("blocks tool call", async () => {
    const mw: Middleware[] = [
      {
        name: "blocker",
        toolCallInterceptor: () => ({ block: true as const, reason: "denied" }),
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
    expect(result).toEqual({ type: "block", reason: "denied" });
  });

  test("returns cached result", async () => {
    const mw: Middleware[] = [
      {
        name: "cache",
        toolCallInterceptor: () => ({ result: "cached" }),
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx());
    expect(result).toEqual({ type: "result", result: "cached" });
  });

  test("transforms args", async () => {
    const mw: Middleware[] = [
      {
        name: "transformer",
        toolCallInterceptor: (_name, args) => ({
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
        toolCallInterceptor: (_name, args) => ({
          args: { ...args, x: 1 },
        }),
      },
      {
        name: "add-y",
        toolCallInterceptor: (_name, args) => ({
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
      { name: "upper", outputFilter: (text) => text.toUpperCase() },
      { name: "trim", outputFilter: (text) => text.trim() },
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
        outputFilter: (text) => text.replace(/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, "[SSN REDACTED]"),
      },
    ];
    const result = await runOutputFilters(mw, "SSN is 123-45-6789", makeCtx());
    expect(result).toBe("SSN is [SSN REDACTED]");
  });

  test("skips middleware without outputFilter", async () => {
    const mw: Middleware[] = [
      { name: "no-filter" },
      { name: "has-filter", outputFilter: (text) => `[${text}]` },
    ];
    const result = await runOutputFilters(mw, "hello", makeCtx());
    expect(result).toBe("[hello]");
  });

  test("supports async output filters", async () => {
    const mw: Middleware[] = [
      {
        name: "async-filter",
        outputFilter: async (text) => {
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
        beforeTurn: (_text, ctx) => {
          (ctx.state as { count: number }).count++;
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
          (ctx.state as { turns: number }).turns++;
        },
      },
    ];
    await runAfterTurnMiddleware(mw, "hello", makeCtx(state));
    expect(state.turns).toBe(1);
  });

  test("toolCallInterceptor can access state for caching", async () => {
    const state = { cache: { "tool:{}": "cached-result" } };
    const mw: Middleware[] = [
      {
        name: "cache",
        toolCallInterceptor: (toolName, args, ctx) => {
          const cache = (ctx.state as { cache: Record<string, string> }).cache;
          const key = `${toolName}:${JSON.stringify(args)}`;
          if (cache[key]) return { result: cache[key] };
        },
      },
    ];
    const result = await runToolCallInterceptors(mw, "tool", {}, makeCtx(state));
    expect(result).toEqual({ type: "result", result: "cached-result" });
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

  test("empty middleware array is a no-op for toolCallInterceptors", async () => {
    const result = await runToolCallInterceptors([], "tool", {}, makeCtx());
    expect(result).toBeUndefined();
  });

  test("block in second middleware prevents third from running", async () => {
    const third = vi.fn();
    const mw: Middleware[] = [
      { name: "first", toolCallInterceptor: vi.fn() },
      {
        name: "blocker",
        toolCallInterceptor: () => ({ block: true as const, reason: "stop" }),
      },
      { name: "third", toolCallInterceptor: third },
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
        toolCallInterceptor: () => ({ result: "fast" }),
      },
      { name: "second", toolCallInterceptor: second },
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
      { name: "redact-ssn", outputFilter: (t) => t.replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]") },
      { name: "redact-email", outputFilter: (t) => t.replace(/\b\S+@\S+\.\S+\b/g, "[EMAIL]") },
      { name: "wrap", outputFilter: (t) => `filtered: ${t}` },
    ];
    const result = await runOutputFilters(
      mw,
      "Contact john@example.com, SSN 123-45-6789",
      makeCtx(),
    );
    expect(result).toBe("filtered: Contact [EMAIL], SSN [SSN]");
  });
});
