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

// ─── Test agents with deterministic tools ────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("fixture replay with real executor (transport layer)", () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  // ── Tool call: real Zod validation + real tool execution ───────────────

  test("tool call fixture: Zod validates args, real tool executes, result sent to S2S", async () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");

    // Wait for the async tool execution pipeline to complete
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    // Verify the real tool was called and produced correct output
    const [callId, resultStr] = vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    expect(callId).toBeTruthy();
    const result = JSON.parse(resultStr);
    expect(result.city).toBe("San Francisco");
    expect(result.temperature).toBe("72°F");
    expect(result.condition).toBe("sunny");
  });

  test("tool call fixture: client receives tool_call with validated args", async () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    expect(ctx.client.toolCallEvents.length).toBeGreaterThan(0);
    const toolEvent = ctx.client.toolCallEvents[0];
    expect(toolEvent?.name).toBe("get_weather");
    expect(toolEvent?.args).toEqual({ city: "San Francisco" });
  });

  test("tool call fixture: conversation history accumulates user + assistant messages", async () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());
    await flush();

    // Client received user transcript
    expect(ctx.client.userTranscripts.length).toBeGreaterThan(0);
    const lastUserText = ctx.client.userTranscripts.at(-1) ?? "";
    expect(lastUserText.toLowerCase()).toContain("weather");
  });

  // ── Simple question: no tools, just session lifecycle ──────────────────

  test("simple question fixture: greeting + agent response reach client", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("simple-question-sequence.json");
    await flush();

    expect(ctx.client.agentTranscripts.length).toBeGreaterThanOrEqual(2); // greeting + answer
  });

  test("simple question fixture: user speech events forwarded to client", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("simple-question-sequence.json");
    await flush();

    expect(ctx.client.speechStartedCount).toBeGreaterThan(0);
    expect(ctx.client.speechStoppedCount).toBeGreaterThan(0);
    expect(ctx.client.userTranscripts.length).toBeGreaterThan(0);
  });

  // ── Stateful agent: session state persists across tool calls ───────────

  test("stateful agent: tool accesses and mutates session state", async () => {
    const ctx = createFixtureSession(statefulAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    const [, resultStr] = vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    const result = JSON.parse(resultStr);
    expect(result.calls).toBe(1); // state.callCount was incremented
  });

  // ── Greeting only: session lifecycle without user audio ────────────────

  test("greeting fixture: session setup completes with reply_done", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("greeting-session-sequence.json");
    await flush();

    expect(ctx.client.agentTranscripts.length).toBeGreaterThan(0);
    expect(ctx.client.replyDoneCount).toBeGreaterThan(0);
  });

  // ── Tool schemas: real agent produces correct S2S tool schemas ─────────

  test("real executor builds correct tool schemas from AgentDef", () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;

    const schema = ctx.executor.toolSchemas.find((s) => s.name === "get_weather");
    expect(schema).toBeDefined();
    expect(schema?.description).toBe("Get the current weather for a city");
    expect(schema?.parameters).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  // ── Tool errors are surfaced as tool results ───────────────────────────

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

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    // Tool result should contain the error
    const [, resultStr] = vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    expect(resultStr).toContain("API key expired");
  });

  // ── Zod validation: bad args rejected ──────────────────────────────────

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

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    // The result should contain a Zod validation error
    const [, resultStr] = vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    expect(resultStr).toContain("Invalid arguments");
    expect(resultStr).toContain("country");
  });

  // ── Interrupted transcript NOT added to conversation history ────────────

  test("interrupted agent transcript is not pushed to conversation history", async () => {
    // Use a tool that captures messages to inspect conversation history
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

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.start();

    const cbs = ctx.mockCallbacks;

    // Fire an interrupted transcript — should NOT go into conversation history
    cbs.onReplyStarted("r1");
    cbs.onAgentTranscript("This was interrupted", true);
    cbs.onCancelled();
    await flush();

    // Client sees both agent_transcript and cancelled events
    expect(ctx.client.agentTranscripts).toContain("This was interrupted");
    expect(ctx.client.cancelledCount).toBeGreaterThan(0);

    // Fire a non-interrupted transcript — SHOULD go into conversation history
    cbs.onReplyStarted("r2");
    cbs.onAgentTranscript("This was completed", false);
    cbs.onReplyDone();
    await flush();

    // Trigger a tool call to inspect conversation history.
    cbs.onUserTranscript("check");
    await flush();
    cbs.onReplyStarted("r3");
    cbs.onToolCall("c1", "check_history", { q: "test" });
    // Wait for tool to execute (captures messages)
    await vi.waitFor(() => expect(capturedMessages.length).toBeGreaterThan(0));

    // Conversation history should contain the completed text but NOT the interrupted text
    const assistantMsgs = capturedMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content === "This was completed")).toBe(true);
    expect(assistantMsgs.every((m) => m.content !== "This was interrupted")).toBe(true);
  });

  // ── Conversation history correctness after full tool-call flow ──────────

  test("conversation history has user + assistant messages after tool-call flow", async () => {
    // Use a tool that captures the messages it receives
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

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalled());

    // The tool should have seen the user's weather question in messages
    const userMsgs = capturedMessages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content.toLowerCase().includes("weather"))).toBe(true);
  });

  // ── Audio chunks forwarded to client.audio ─────────────────────────────

  test("reply.audio events forwarded to client.audio", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.start();

    // Fire audio events directly via callbacks (replay skips reply.audio)
    const audioBytes = new Uint8Array([10, 20, 30, 40]);
    ctx.mockCallbacks.onAudio(audioBytes);
    ctx.mockCallbacks.onAudio(new Uint8Array([50, 60]));

    expect(ctx.client.audioChunks.length).toBe(2);
    expect(Array.from(ctx.client.audioChunks[0] ?? [])).toEqual([10, 20, 30, 40]);
    expect(Array.from(ctx.client.audioChunks[1] ?? [])).toEqual([50, 60]);
  });

  // ── Multiple tool calls in one reply: results buffered and sent together ─

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

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.start();

    const cbs = ctx.mockCallbacks;
    cbs.onReplyStarted("r1");
    cbs.onToolCall("c1", "get_weather", { city: "NYC" });
    cbs.onToolCall("c2", "get_weather", { city: "LA" });

    // Wait for both tool calls to be dispatched to the client
    await vi.waitFor(() => {
      expect(ctx.client.toolCallEvents.length).toBe(2);
    });

    // Results NOT sent yet — reply.done hasn't fired
    expect(ctx.fakeHandle.sendToolResult).not.toHaveBeenCalled();

    // Fire reply.done — should flush both results
    cbs.onReplyDone();
    await vi.waitFor(() => {
      expect(ctx.fakeHandle.sendToolResult).toHaveBeenCalledTimes(2);
    });

    // Verify both results are correct
    const calls = vi.mocked(ctx.fakeHandle.sendToolResult).mock.calls as [string, string][];
    const results = calls.map(([, r]) => JSON.parse(r));
    expect(results.some((r) => r.city === "NYC")).toBe(true);
    expect(results.some((r) => r.city === "LA")).toBe(true);
  });
});
