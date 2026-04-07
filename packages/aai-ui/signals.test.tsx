// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockSession, flush, setupSignalsEnv } from "./_test-utils.ts";
import { SessionProvider, useSession, useToolResult } from "./signals.ts";
import type { ToolCallInfo } from "./types.ts";

describe("VoiceSession controls", () => {
  let env: ReturnType<typeof setupSignalsEnv>;

  beforeEach(() => {
    env = setupSignalsEnv();
  });

  afterEach(() => {
    env.restore();
  });

  test("has correct defaults", () => {
    expect(env.session.state.value).toBe("disconnected");
    expect(env.session.messages.value).toEqual([]);
    expect(env.session.userUtterance.value).toBe(null);
    expect(env.session.error.value).toBe(null);
    expect(env.session.started.value).toBe(false);
    expect(env.session.running.value).toBe(true);
  });

  test("sets running to false on error state", async () => {
    await env.connect();
    expect(env.session.running.value).toBe(true);
    env.send({ type: "error", code: "internal", message: "fatal" });
    expect(env.session.running.value).toBe(false);
    env.session.disconnect();
  });

  test("start() sets started/running and connects", async () => {
    expect(env.session.started.value).toBe(false);
    env.session.start();
    await flush();

    expect(env.session.started.value).toBe(true);
    expect(env.session.running.value).toBe(true);
    expect(env.mock.lastWs !== null).toBe(true);
    env.session.disconnect();
  });

  test("toggle() disconnects then reconnects", async () => {
    env.session.start();
    await flush();

    env.session.toggle();
    expect(env.session.running.value).toBe(false);

    env.session.toggle();
    await flush();
    expect(env.session.running.value).toBe(true);
    env.session.disconnect();
  });

  test("reset() sends reset message", async () => {
    await env.connect();

    const before = env.mock.lastWs?.sent.length;
    env.session.reset();

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
    const session = createMockSession({ started: true, state: "listening" });
    const calls: [string, unknown][] = [];

    function Harness() {
      useToolResult((name, result) => {
        calls.push([name, result]);
      });
      return <div />;
    }

    render(
      <SessionProvider value={session}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    session.toolCalls.value = [
      makeTc({
        toolCallId: "tc1",
        toolName: "add_pizza",
        result: JSON.stringify({ added: true }),
      }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([["add_pizza", { added: true }]]);

    session.toolCalls.value = [
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
    const session = createMockSession({ started: true, state: "listening" });
    const calls: string[] = [];

    function Harness() {
      useToolResult((name) => {
        calls.push(name);
      });
      return <div />;
    }

    render(
      <SessionProvider value={session}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    session.toolCalls.value = [
      makeTc({ toolCallId: "tc1", toolName: "search", status: "pending", result: undefined }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([]);

    session.toolCalls.value = [
      makeTc({ toolCallId: "tc1", toolName: "search", result: JSON.stringify({ found: true }) }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["search"]);
  });

  test("resets tracking when tool calls are cleared", async () => {
    const session = createMockSession({ started: true, state: "listening" });
    const calls: string[] = [];

    function Harness() {
      useToolResult((name) => {
        calls.push(name);
      });
      return <div />;
    }

    render(
      <SessionProvider value={session}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    session.toolCalls.value = [makeTc({ toolCallId: "tc1", toolName: "add_pizza" })];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["add_pizza"]);

    session.toolCalls.value = [];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["add_pizza"]);

    session.toolCalls.value = [makeTc({ toolCallId: "tc2", toolName: "add_pizza" })];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["add_pizza", "add_pizza"]);
  });

  test("filters by tool name when first argument is a string", async () => {
    const session = createMockSession({ started: true, state: "listening" });
    const results: unknown[] = [];

    function Harness() {
      useToolResult("add_pizza", (result) => {
        results.push(result);
      });
      return <div />;
    }

    render(
      <SessionProvider value={session}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    session.toolCalls.value = [
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
    const session = createMockSession({ started: true, state: "listening" });
    const results: unknown[] = [];

    function Harness() {
      useToolResult((_name, result) => {
        results.push(result);
      });
      return <div />;
    }

    render(
      <SessionProvider value={session}>
        <Harness />
      </SessionProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);

    session.toolCalls.value = [
      makeTc({ toolCallId: "tc1", toolName: "broken", result: "not json{" }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(results).toEqual(["not json{"]);
  });
});
