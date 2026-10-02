// @vitest-environment jsdom
/**
 * `useClientTool` over a REAL browser session: a `tool.called` frame in, the
 * handler run, one `tool_result` frame out — the page's half of a `clientTool`.
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks, renderHookWithSession } from "./_react-test-utils.ts";
import {
  assertValidClientFrames,
  type MockWebSocket,
  makeConfig,
  recordingWebSocketClass,
} from "./_session-core-test-utils.ts";
import { useClientTool } from "./client-tool.ts";
import type { BrowserSession } from "./session/index.ts";
import { createBrowserSession, loadAudioModules } from "./session/index.ts";

function noop(): void {
  /* silence */
}

describe("useClientTool", () => {
  let socket: MockWebSocket | null = null;
  const WS = recordingWebSocketClass((s) => {
    socket = s;
  });

  beforeEach(async () => {
    await loadAudioModules();
    vi.useFakeTimers();
    installAudioMocks();
    socket = null;
    sessionStorage.clear();
    vi.spyOn(console, "warn").mockImplementation(noop);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function live(): Promise<BrowserSession> {
    const core = createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    return core;
  }

  function called(toolCallId: string, toolName: string, args: unknown = {}): void {
    act(() => {
      socket?.simulateMessage(JSON.stringify({ type: "tool.called", toolCallId, toolName, args }));
    });
  }

  /** Every `tool_result` frame the client sent, parsed. */
  function sentResults(): unknown[] {
    return (socket?.send.mock.calls ?? [])
      .map((call) => call[0])
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as { type: string })
      .filter((frame) => frame.type === "tool_result");
  }

  it("runs the handler with the call's args and answers with its JSON result", async () => {
    const core = await live();
    const handler = vi.fn(async (args: { city: string }) => ({ temp: 21, city: args.city }));
    renderHookWithSession(() => useClientTool("get_weather", handler), core);

    called("tc-1", "get_weather", { city: "Oslo" });
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ city: "Oslo" });
    expect(sentResults()).toEqual([
      {
        type: "tool_result",
        toolCallId: "tc-1",
        result: JSON.stringify({ temp: 21, city: "Oslo" }),
      },
    ]);
    assertValidClientFrames(socket);
    core.disconnect();
  });

  it("ignores other tools, and runs each call once however often it re-renders", async () => {
    const core = await live();
    const handler = vi.fn(() => "ok");
    const { rerender } = renderHookWithSession(() => useClientTool("pick", handler), core);

    called("tc-1", "web_search");
    called("tc-2", "pick");
    rerender();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(sentResults()).toEqual([{ type: "tool_result", toolCallId: "tc-2", result: '"ok"' }]);
    core.disconnect();
  });

  it("fails the call with the message when the handler throws or rejects", async () => {
    const core = await live();
    renderHookWithSession(() => {
      useClientTool("sync_fail", () => {
        throw new Error("no camera");
      });
      useClientTool("async_fail", () => Promise.reject(new Error("denied")));
    }, core);

    called("tc-1", "sync_fail");
    called("tc-2", "async_fail");
    await vi.advanceTimersByTimeAsync(0);

    expect(sentResults()).toEqual([
      { type: "tool_result", toolCallId: "tc-1", result: "", error: "no camera" },
      { type: "tool_result", toolCallId: "tc-2", result: "", error: "denied" },
    ]);
    assertValidClientFrames(socket);
    core.disconnect();
  });

  it("fails the call, rather than throwing, when the result cannot be JSON-encoded", async () => {
    const core = await live();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    renderHookWithSession(() => useClientTool("loop", () => cyclic), core);

    called("tc-1", "loop");
    await vi.advanceTimersByTimeAsync(0);

    const [frame] = sentResults() as { error?: string }[];
    expect(frame?.error).toMatch(/not JSON-serializable/);
    core.disconnect();
  });

  it("sends nothing while disconnected", () => {
    const idle = createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    expect(() => idle.sendToolResult("tc-1", { result: 1 })).not.toThrow();
    expect(socket).toBeNull();
  });
});
