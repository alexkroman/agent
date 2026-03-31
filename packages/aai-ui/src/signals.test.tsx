// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockSignals, flush, setupSignalsEnv } from "./lib/test-utils.ts";
import { SessionProvider, useSession, useToolResult } from "./signals.ts";
import type { ToolCallInfo } from "./types.ts";

describe("createSessionControls", () => {
  let env: ReturnType<typeof setupSignalsEnv>;

  beforeEach(() => {
    env = setupSignalsEnv();
  });

  afterEach(() => {
    env.restore();
  });

  test("has correct defaults", () => {
    expect(env.signals.session.state.value).toBe("disconnected");
    expect(env.signals.session.messages.value).toEqual([]);
    expect(env.signals.session.userUtterance.value).toBe(null);
    expect(env.signals.session.error.value).toBe(null);
    expect(env.signals.started.value).toBe(false);
    expect(env.signals.running.value).toBe(true);
  });

  test("sets running to false on error state", async () => {
    await env.connect();
    expect(env.signals.running.value).toBe(true);
    env.send({ type: "error", code: "internal", message: "fatal" });
    expect(env.signals.running.value).toBe(false);
    env.session.disconnect();
  });

  test("start() sets started/running and connects", async () => {
    expect(env.signals.started.value).toBe(false);
    env.signals.start();
    await flush();

    expect(env.signals.started.value).toBe(true);
    expect(env.signals.running.value).toBe(true);
    expect(env.mock.lastWs !== null).toBe(true);
    env.session.disconnect();
  });

  test("toggle() disconnects then reconnects", async () => {
    env.signals.start();
    await flush();

    env.signals.toggle();
    expect(env.signals.running.value).toBe(false);

    env.signals.toggle();
    await flush();
    expect(env.signals.running.value).toBe(true);
    env.session.disconnect();
  });

  test("reset() sends reset message", async () => {
    await env.connect();

    const before = env.mock.lastWs?.sent.length;
    env.signals.reset();

    const sent =
      env.mock.lastWs?.sent.slice(before).filter((d): d is string => typeof d === "string") ?? [];
    expect(sent.some((s) => JSON.parse(s).type === "reset")).toBe(true);
    env.session.disconnect();
  });
});

describe("useSession", () => {
  test("throws outside SessionProvider", () => {
    function Orphan() {
      useSession();
      return <div />;
    }

    let caught: Error | null = null;
    try {
      render(<Orphan />);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBe(null);
    expect(caught?.message).toContain("Hook useSession() requires a SessionProvider");
  });
});

function makeTc(
  overrides: Partial<ToolCallInfo> & { toolCallId: string; toolName: string },
): ToolCallInfo {
  return {
    args: {},
    status: "done",
    result: JSON.stringify({ ok: true }),
    afterMessageIndex: 0,
    ...overrides,
  };
}

describe("useToolResult", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("fires callback once per completed tool call", async () => {
    const signals = createMockSignals({ started: true, state: "listening" });
    const calls: [string, unknown][] = [];

    function Harness() {
      useToolResult((name, result) => {
        calls.push([name, result]);
      });
      return <div />;
    }

    render(
      <SessionProvider value={signals}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    signals.session.toolCalls.value = [
      makeTc({
        toolCallId: "tc1",
        toolName: "add_pizza",
        result: JSON.stringify({ added: true }),
      }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([["add_pizza", { added: true }]]);

    signals.session.toolCalls.value = [
      makeTc({
        toolCallId: "tc1",
        toolName: "add_pizza",
        result: JSON.stringify({ added: true }),
      }),
      makeTc({
        toolCallId: "tc2",
        toolName: "remove_pizza",
        result: JSON.stringify({ removed: true }),
      }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([
      ["add_pizza", { added: true }],
      ["remove_pizza", { removed: true }],
    ]);
  });

  test("skips pending tool calls", async () => {
    const signals = createMockSignals({ started: true, state: "listening" });
    const calls: string[] = [];

    function Harness() {
      useToolResult((name) => {
        calls.push(name);
      });
      return <div />;
    }

    render(
      <SessionProvider value={signals}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    signals.session.toolCalls.value = [
      makeTc({ toolCallId: "tc1", toolName: "search", status: "pending", result: undefined }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([]);

    signals.session.toolCalls.value = [
      makeTc({ toolCallId: "tc1", toolName: "search", result: JSON.stringify({ found: true }) }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["search"]);
  });

  test("resets tracking when tool calls are cleared", async () => {
    const signals = createMockSignals({ started: true, state: "listening" });
    const calls: string[] = [];

    function Harness() {
      useToolResult((name) => {
        calls.push(name);
      });
      return <div />;
    }

    render(
      <SessionProvider value={signals}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    signals.session.toolCalls.value = [makeTc({ toolCallId: "tc1", toolName: "add_pizza" })];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["add_pizza"]);

    signals.session.toolCalls.value = [];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["add_pizza"]);

    signals.session.toolCalls.value = [makeTc({ toolCallId: "tc2", toolName: "add_pizza" })];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["add_pizza", "add_pizza"]);
  });

  test("filters by tool name when first argument is a string", async () => {
    const signals = createMockSignals({ started: true, state: "listening" });
    const results: unknown[] = [];

    function Harness() {
      useToolResult("add_pizza", (result) => {
        results.push(result);
      });
      return <div />;
    }

    render(
      <SessionProvider value={signals}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    signals.session.toolCalls.value = [
      makeTc({
        toolCallId: "tc1",
        toolName: "add_pizza",
        result: JSON.stringify({ added: true }),
      }),
      makeTc({
        toolCallId: "tc2",
        toolName: "remove_pizza",
        result: JSON.stringify({ removed: true }),
      }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(results).toEqual([{ added: true }]);
  });

  test("passes raw string when result is not valid JSON", async () => {
    const signals = createMockSignals({ started: true, state: "listening" });
    const results: unknown[] = [];

    function Harness() {
      useToolResult((_name, result) => {
        results.push(result);
      });
      return <div />;
    }

    render(
      <SessionProvider value={signals}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    signals.session.toolCalls.value = [
      makeTc({ toolCallId: "tc1", toolName: "broken", result: "not json{" }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(results).toEqual(["not json{"]);
  });
});
