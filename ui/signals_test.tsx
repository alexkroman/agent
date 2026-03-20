// Copyright 2025 the AAI authors. MIT license.

import { render } from "preact";
import { describe, expect, test, vi } from "vitest";
import {
  createMockSignals,
  delay,
  flush,
  getContainer,
  setupDOM,
  withDOM,
  withSignalsEnv,
} from "./_test_utils.ts";
import { SessionProvider, useSession, useToolResult } from "./signals.ts";
import type { ToolCallInfo } from "./types.ts";

describe("createSessionControls", () => {
  test(
    "has correct defaults",
    withSignalsEnv(({ signals }) => {
      expect(signals.session.state.value).toBe("disconnected");
      expect(signals.session.messages.value).toEqual([]);
      expect(signals.session.userUtterance.value).toBe(null);
      expect(signals.session.error.value).toBe(null);
      expect(signals.started.value).toBe(false);
      expect(signals.running.value).toBe(true);
    }),
  );

  test(
    "sets running to false on error state",
    withSignalsEnv(async ({ signals, connect, send, session }) => {
      await connect();
      expect(signals.running.value).toBe(true);
      send({ type: "error", code: "internal", message: "fatal" });
      expect(signals.running.value).toBe(false);
      session.disconnect();
    }),
  );

  test(
    "start() sets started/running and connects",
    withSignalsEnv(async ({ mock, signals, session }) => {
      expect(signals.started.value).toBe(false);
      signals.start();
      await flush();

      expect(signals.started.value).toBe(true);
      expect(signals.running.value).toBe(true);
      expect(mock.lastWs !== null).toBe(true);
      session.disconnect();
    }),
  );

  test(
    "toggle() disconnects then reconnects",
    withSignalsEnv(async ({ signals, session }) => {
      signals.start();
      await flush();

      signals.toggle();
      expect(signals.running.value).toBe(false);

      signals.toggle();
      await flush();
      expect(signals.running.value).toBe(true);
      session.disconnect();
    }),
  );

  test(
    "reset() sends reset message",
    withSignalsEnv(async ({ mock, signals, connect, session }) => {
      await connect();

      const before = mock.lastWs?.sent.length;
      signals.reset();

      const sent =
        mock.lastWs?.sent.slice(before).filter((d): d is string => typeof d === "string") ?? [];
      expect(sent.some((s) => JSON.parse(s).type === "reset")).toBe(true);
      session.disconnect();
    }),
  );
});

describe("useSession", () => {
  test("throws outside SessionProvider", async () => {
    setupDOM();
    const container = getContainer();

    function Orphan() {
      useSession();
      return <div />;
    }

    let caught: Error | null = null;
    try {
      render(<Orphan />, container);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBe(null);
    expect(caught?.message).toContain("Hook useSession() requires a SessionProvider");

    render(null, container);
    await delay(0);
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
  test(
    "fires callback once per completed tool call",
    withDOM(async (container) => {
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
        container,
      );
      await vi.advanceTimersByTimeAsync(0);

      // Add a completed tool call
      signals.session.toolCalls.value = [
        makeTc({
          toolCallId: "tc1",
          toolName: "add_pizza",
          result: JSON.stringify({ added: true }),
        }),
      ];
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual([["add_pizza", { added: true }]]);

      // Update signal again with same tool call + a new one — should only fire for the new one
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
    }),
  );

  test(
    "skips pending tool calls",
    withDOM(async (container) => {
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
        container,
      );
      await vi.advanceTimersByTimeAsync(0);

      signals.session.toolCalls.value = [
        makeTc({ toolCallId: "tc1", toolName: "search", status: "pending", result: undefined }),
      ];
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual([]);

      // Now complete it
      signals.session.toolCalls.value = [
        makeTc({ toolCallId: "tc1", toolName: "search", result: JSON.stringify({ found: true }) }),
      ];
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["search"]);
    }),
  );

  test(
    "resets tracking when tool calls are cleared",
    withDOM(async (container) => {
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
        container,
      );
      await vi.advanceTimersByTimeAsync(0);

      signals.session.toolCalls.value = [makeTc({ toolCallId: "tc1", toolName: "add_pizza" })];
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["add_pizza"]);

      // Reset (clear tool calls)
      signals.session.toolCalls.value = [];
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["add_pizza"]);

      // New session — same tool name, new ID should fire
      signals.session.toolCalls.value = [makeTc({ toolCallId: "tc2", toolName: "add_pizza" })];

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["add_pizza", "add_pizza"]);
    }),
  );

  test(
    "passes raw string when result is not valid JSON",
    withDOM(async (container) => {
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
        container,
      );
      await vi.advanceTimersByTimeAsync(0);

      signals.session.toolCalls.value = [
        makeTc({ toolCallId: "tc1", toolName: "broken", result: "not json{" }),
      ];
      await vi.advanceTimersByTimeAsync(0);

      expect(results).toEqual(["not json{"]);
    }),
  );
});
