// Copyright 2025 the AAI authors. MIT license.
/**
 * Fixture replay tests with a REAL Runtime — now wired to the transport layer.
 *
 * Replays recorded AssemblyAI S2S messages (from Kokoro TTS audio) through
 * a real agent session — real tool execution, real Zod arg validation, real
 * hook invocation.
 *
 * This exercises: AgentDef → toAgentConfig → tool schemas → Zod validation
 * → executeToolCall → session orchestration (reply guards, tool buffering,
 * turnPromise chaining, conversation history).
 *
 * Migrated from host/fixture-replay.test.ts (Task 19). Uses createFixtureSession
 * which spies on s2s-transport.ts _internals.connectS2s and fires S2sCallbacks
 * directly — no nanoevents / old S2sEvents system.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { AgentDef } from "../../sdk/types.ts";
import { createFixtureSession, flush } from "../_test-utils.ts";

type FixtureSession = ReturnType<typeof createFixtureSession>;

function firstToolResult(ctx: FixtureSession): [string, string] {
  return vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls[0] as [string, string];
}

const weatherAgent: AgentDef = {
  name: "weather-agent",
  systemPrompt: "You are a weather assistant.",
  greeting: "Ask me about the weather!",
  maxSteps: 5,
  tools: {
    get_weather: {
      description: "Get the current weather for a city",
      parameters: z.object({
        city: z.string().describe("City name"),
      }),
      execute: ({ city }: { city: string }) => ({
        city,
        temperature: "72°F",
        condition: "sunny",
        humidity: "45%",
      }),
    },
  },
};

const simpleAgent: AgentDef = {
  name: "simple-agent",
  systemPrompt: "You are a helpful assistant.",
  greeting: "Hi!",
  maxSteps: 5,
  tools: {},
};

const statefulAgent: AgentDef<{ callCount: number }> = {
  name: "stateful-agent",
  systemPrompt: "You are helpful.",
  greeting: "Hi!",
  maxSteps: 5,
  state: () => ({ callCount: 0 }),
  tools: {
    get_weather: {
      description: "Get weather",
      parameters: z.object({ city: z.string() }),
      execute: ({ city }: { city: string }, ctx) => {
        ctx.state.callCount++;
        return { city, calls: ctx.state.callCount };
      },
    },
  },
};

describe("fixture replay with real executor (transport layer)", () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  function makeCtx(agent: AgentDef): FixtureSession {
    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    return ctx;
  }

  test("tool call fixture: Zod validates args, real tool executes, result sent to S2S", async () => {
    const ctx = makeCtx(weatherAgent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    const [callId, resultStr] = firstToolResult(ctx);
    expect(callId).toBeTruthy();
    const result = JSON.parse(resultStr);
    expect(result.city).toBe("San Francisco");
    expect(result.temperature).toBe("72°F");
    expect(result.condition).toBe("sunny");
  });

  test("tool call fixture: client receives tool_call with validated args", async () => {
    const ctx = makeCtx(weatherAgent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    expect(ctx.client.toolCallEvents.length).toBeGreaterThan(0);
    const toolEvent = ctx.client.toolCallEvents[0];
    expect(toolEvent?.name).toBe("get_weather");
    expect(toolEvent?.args).toEqual({ city: "San Francisco" });
  });

  test("tool call fixture: conversation history accumulates user + assistant messages", async () => {
    const ctx = makeCtx(weatherAgent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());
    await flush();

    expect(ctx.client.userTranscripts.length).toBeGreaterThan(0);
    const lastUserText = ctx.client.userTranscripts.at(-1) ?? "";
    expect(lastUserText.toLowerCase()).toContain("weather");
  });

  test("simple question fixture: greeting + agent response reach client", async () => {
    const ctx = makeCtx(simpleAgent);
    await ctx.start();

    ctx.replay("simple-question-sequence.json");
    await flush();

    expect(ctx.client.agentTranscripts.length).toBeGreaterThanOrEqual(2);
  });

  test("simple question fixture: user speech events forwarded to client", async () => {
    const ctx = makeCtx(simpleAgent);
    await ctx.start();

    ctx.replay("simple-question-sequence.json");
    await flush();

    expect(ctx.client.speechStartedCount).toBeGreaterThan(0);
    expect(ctx.client.speechStoppedCount).toBeGreaterThan(0);
    expect(ctx.client.userTranscripts.length).toBeGreaterThan(0);
  });

  test("stateful agent: tool accesses and mutates session state", async () => {
    const ctx = makeCtx(statefulAgent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    const [, resultStr] = firstToolResult(ctx);
    const result = JSON.parse(resultStr);
    expect(result.calls).toBe(1);
  });

  test("greeting fixture: session setup completes with reply_done", async () => {
    const ctx = makeCtx(simpleAgent);
    await ctx.start();

    ctx.replay("greeting-session-sequence.json");
    await flush();

    expect(ctx.client.agentTranscripts.length).toBeGreaterThan(0);
    expect(ctx.client.replyDoneCount).toBeGreaterThan(0);
  });

  test("real executor builds correct tool schemas from AgentDef", () => {
    const ctx = makeCtx(weatherAgent);

    const schema = ctx.executor.toolSchemas.find((s) => s.name === "get_weather");
    expect(schema).toBeDefined();
    expect(schema?.description).toBe("Get the current weather for a city");
    expect(schema?.parameters).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  test("tool throw is surfaced as error result", async () => {
    const agent: AgentDef = {
      name: "error-agent",
      systemPrompt: "Weather assistant.",
      greeting: "Ask about weather!",
      maxSteps: 5,
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: () => {
            throw new Error("API key expired");
          },
        },
      },
    };

    const ctx = makeCtx(agent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    const [, resultStr] = firstToolResult(ctx);
    expect(resultStr).toContain("API key expired");
  });

  test("Zod validation rejects malformed tool args", async () => {
    const agent: AgentDef = {
      name: "strict-agent",
      systemPrompt: "Weather assistant.",
      greeting: "Ask about weather!",
      maxSteps: 5,
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: z.object({
            city: z.string(),
            country: z.string(), // required but not in fixture
          }),
          execute: () => "should not run",
        },
      },
    };

    const ctx = makeCtx(agent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    const [, resultStr] = firstToolResult(ctx);
    expect(resultStr).toContain("Invalid arguments");
    expect(resultStr).toContain("country");
  });

  test("interrupted agent transcript is not pushed to conversation history", async () => {
    let capturedMessages: readonly { role: string; content: string }[] = [];
    const agent: AgentDef = {
      name: "interrupt-history-agent",
      systemPrompt: "You are helpful.",
      greeting: "Hi!",
      maxSteps: 5,
      tools: {
        check_history: {
          description: "Check history",
          parameters: z.object({ q: z.string() }),
          execute: (_args: unknown, ctx) => {
            capturedMessages = [...ctx.messages];
            return "ok";
          },
        },
      },
    };

    const ctx = makeCtx(agent);
    await ctx.start();

    const cbs = ctx.mockCallbacks;

    cbs.onReplyStarted("r1");
    cbs.onAgentTranscript("This was interrupted", true);
    cbs.onCancelled();
    await flush();

    expect(ctx.client.agentTranscripts).toContain("This was interrupted");
    expect(ctx.client.cancelledCount).toBeGreaterThan(0);

    cbs.onReplyStarted("r2");
    cbs.onAgentTranscript("This was completed", false);
    cbs.onReplyDone();
    await flush();

    cbs.onUserTranscript("check");
    await flush();
    cbs.onReplyStarted("r3");
    cbs.onToolCall("c1", "check_history", { q: "test" });
    await vi.waitFor(() => expect(capturedMessages.length).toBeGreaterThan(0));

    const assistantMsgs = capturedMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content === "This was completed")).toBe(true);
    expect(assistantMsgs.every((m) => m.content !== "This was interrupted")).toBe(true);
  });

  test("conversation history has user + assistant messages after tool-call flow", async () => {
    let capturedMessages: readonly { role: string; content: string }[] = [];
    const agent: AgentDef = {
      name: "history-agent",
      systemPrompt: "Weather assistant.",
      greeting: "Ask about weather!",
      maxSteps: 5,
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }: { city: string }, ctx) => {
            capturedMessages = [...ctx.messages];
            return { city, temp: "72°F" };
          },
        },
      },
    };

    const ctx = makeCtx(agent);
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    const userMsgs = capturedMessages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content.toLowerCase().includes("weather"))).toBe(true);
  });

  test("reply.audio events forwarded to client.audio", async () => {
    const ctx = makeCtx(simpleAgent);
    await ctx.start();

    ctx.mockCallbacks.onAudio(new Uint8Array([10, 20, 30, 40]));
    ctx.mockCallbacks.onAudio(new Uint8Array([50, 60]));

    expect(ctx.client.audioChunks.length).toBe(2);
    expect(Array.from(ctx.client.audioChunks[0] ?? [])).toEqual([10, 20, 30, 40]);
    expect(Array.from(ctx.client.audioChunks[1] ?? [])).toEqual([50, 60]);
  });

  test("multiple tool calls in one reply: all results buffered and sent after replyDone", async () => {
    const agent: AgentDef = {
      name: "multi-tool-agent",
      systemPrompt: "Weather assistant.",
      greeting: "Hi!",
      maxSteps: 5,
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }: { city: string }) => ({ city, temp: "72°F" }),
        },
      },
    };

    const ctx = makeCtx(agent);
    await ctx.start();

    const cbs = ctx.mockCallbacks;
    cbs.onReplyStarted("r1");
    cbs.onToolCall("c1", "get_weather", { city: "NYC" });
    cbs.onToolCall("c2", "get_weather", { city: "LA" });

    await vi.waitFor(() => {
      expect(ctx.client.toolCallEvents.length).toBe(2);
    });

    expect(ctx.fakeHandle.sendToolResult).not.toHaveBeenCalled();

    cbs.onReplyDone();
    await vi.waitFor(() => {
      expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalledTimes(2);
    });

    const calls = vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls as [string, string][];
    const results = calls.map(([, r]) => JSON.parse(r));
    expect(results.some((r) => r.city === "NYC")).toBe(true);
    expect(results.some((r) => r.city === "LA")).toBe(true);
  });
});
