// Copyright 2026 the AAI authors. MIT license.
/**
 * The host-mode tool relay — tool calls out, results back.
 *
 * Split from `host-mode.test.ts` alongside the module it covers; both files
 * were over the length cap after the rate-check and credential work landed.
 */

import type { SessionEventBody } from "@alexkroman1/aai/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRelayExecuteTool } from "./host-relay.ts";

type ToolCallEvent = Extract<SessionEventBody, { type: "tool.called" }>;

function makeSend() {
  const events: ToolCallEvent[] = [];
  const send = vi.fn((e: ToolCallEvent) => {
    events.push(e);
  });
  return { send, events };
}

describe("createRelayExecuteTool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("emits a tool_call frame and resolves on a matching tool_result", async () => {
    const { send, events } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const p = relay.executeTool("lookup", { city: "Paris" }, "sess", [], {
      toolCallId: "call-1",
    });

    expect(events).toEqual([
      { type: "tool.called", toolCallId: "call-1", toolName: "lookup", args: { city: "Paris" } },
    ]);

    relay.onToolResult({ toolCallId: "call-1", result: "sunny" });
    await expect(p).resolves.toBe("sunny");
    relay.dispose();
  });

  test("unwraps a JSON-encoded string result but leaves object JSON intact", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const pStr = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "a" });
    relay.onToolResult({ toolCallId: "a", result: '"hello"' });
    await expect(pStr).resolves.toBe("hello");

    const pObj = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "b" });
    relay.onToolResult({ toolCallId: "b", result: '{"temp":72}' });
    await expect(pObj).resolves.toBe('{"temp":72}');

    const pPlain = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "c" });
    relay.onToolResult({ toolCallId: "c", result: "not json" });
    await expect(pPlain).resolves.toBe("not json");
  });

  test("rejects when the tool_result carries an error", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const p = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "err-1" });
    relay.onToolResult({ toolCallId: "err-1", result: "", error: "boom" });
    await expect(p).rejects.toThrow(/boom/);
  });

  test("ignores tool_result for an unknown toolCallId", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send, timeoutMs: 50 });
    vi.useFakeTimers();

    const p = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "known" });
    const settled = expect(p).rejects.toThrow(/timed out/);

    // A stray result for a different id must not resolve the pending call.
    relay.onToolResult({ toolCallId: "other", result: "nope" });

    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });

  test("times out when no tool_result arrives and cleans up", async () => {
    vi.useFakeTimers();
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send, timeoutMs: 1000 });

    const p = relay.executeTool("slow", {}, undefined, undefined, { toolCallId: "t-1" });
    const settled = expect(p).rejects.toThrow(/slow.*timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    // After timeout the entry is cleared: a late result is a no-op (does not throw).
    expect(() => relay.onToolResult({ toolCallId: "t-1", result: "late" })).not.toThrow();
  });

  test("returns a tool error (does not throw) when no toolCallId is provided", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const result = await relay.executeTool("t", {}, undefined, undefined, {});
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toMatchObject({ error: expect.stringContaining("toolCallId") });
  });

  test("dispose rejects all pending calls", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const p = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "x" });
    const settled = expect(p).rejects.toThrow(/dispose/i);
    relay.dispose();
    await settled;
  });

  test("a duplicate in-flight toolCallId is refused without clobbering the first call", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const first = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "dup" });
    const second = await relay.executeTool("t", {}, undefined, undefined, { toolCallId: "dup" });
    expect(JSON.parse(second)).toMatchObject({ error: expect.stringContaining("dup") });
    // Only the first call emitted a frame.
    expect(send).toHaveBeenCalledTimes(1);

    // The first call still settles from its genuine result.
    relay.onToolResult({ toolCallId: "dup", result: "first" });
    await expect(first).resolves.toBe("first");
    relay.dispose();
  });

  test("aborting the turn signal rejects the pending relay call; a late result is a no-op", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const controller = new AbortController();

    const p = relay.executeTool("t", {}, undefined, undefined, {
      toolCallId: "x",
      signal: controller.signal,
    });
    // p-timeout rejects with the signal's abort reason.
    const settled = expect(p).rejects.toThrow(/aborted/i);
    controller.abort();
    await settled;

    // Entry was cleared: a stale client result after the abort is ignored.
    expect(() => relay.onToolResult({ toolCallId: "x", result: "late" })).not.toThrow();
    relay.dispose();
  });

  test("a pre-aborted signal returns a tool error without emitting a frame", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const controller = new AbortController();
    controller.abort();

    const result = await relay.executeTool("t", {}, undefined, undefined, {
      toolCallId: "x",
      signal: controller.signal,
    });
    expect(JSON.parse(result)).toMatchObject({ error: expect.stringContaining("cancelled") });
    expect(send).not.toHaveBeenCalled();
    relay.dispose();
  });
});
