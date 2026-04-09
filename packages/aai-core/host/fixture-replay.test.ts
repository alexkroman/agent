// Copyright 2025 the AAI authors. MIT license.
/**
 * Fixture replay tests with a REAL Runtime.
 *
 * Replays recorded AssemblyAI S2S messages (from Kokoro TTS audio) through
 * a real agent session — real tool execution, real Zod arg validation, real
 * hook invocation.
 *
 * This exercises: AgentDef → toAgentConfig → tool schemas → Zod validation
 * → executeToolCall → session orchestration (reply guards, tool buffering,
 * turnPromise chaining, conversation history).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { AgentDef } from "../isolate/types.ts";
import { createFixtureSession, flush } from "./_test-utils.ts";

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

describe("fixture replay with real executor", () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  // ── Tool call: real Zod validation + real tool execution ───────────────

  test("tool call fixture: Zod validates args, real tool executes, result sent to S2S", async () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");

    // Wait for the async tool execution pipeline to complete
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // Verify the real tool was called and produced correct output
    const [callId, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
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
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    const toolStart = ctx.client.events.find((e) => (e as { type: string }).type === "tool_call") as
      | { toolName: string; args: Record<string, unknown> }
      | undefined;
    expect(toolStart?.toolName).toBe("get_weather");
    expect(toolStart?.args).toEqual({ city: "San Francisco" });
  });

  test("tool call fixture: conversation history accumulates user + assistant messages", async () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());
    await flush();

    // Client received user transcript
    const turns = ctx.client.events.filter(
      (e) => (e as { type: string }).type === "user_transcript",
    );
    expect(turns.length).toBeGreaterThan(0);
    const userText = (turns.at(-1) as { text: string }).text;
    expect(userText.toLowerCase()).toContain("weather");
  });

  // ── Simple question: no tools, just session lifecycle ──────────────────

  test("simple question fixture: greeting + agent response reach client", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await flush();

    const chats = ctx.client.events.filter(
      (e) => (e as { type: string }).type === "agent_transcript",
    );
    expect(chats.length).toBeGreaterThanOrEqual(2); // greeting + answer
  });

  test("simple question fixture: user speech events forwarded to client", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await flush();

    const types = ctx.client.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("speech_started");
    expect(types).toContain("speech_stopped");
    expect(types).toContain("user_transcript_delta");
    expect(types).toContain("user_transcript");
  });

  // ── Stateful agent: session state persists across tool calls ───────────

  test("stateful agent: tool accesses and mutates session state", async () => {
    const ctx = createFixtureSession(statefulAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    const [, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    const result = JSON.parse(resultStr);
    expect(result.calls).toBe(1); // state.callCount was incremented
  });

  // ── Greeting only: session lifecycle without user audio ────────────────

  test("greeting fixture: session setup completes with tts_done", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("greeting-session-sequence.json");
    await flush();

    const types = ctx.client.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("agent_transcript");
    expect(types).toContain("reply_done");
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

  // ── onConnect / onDisconnect: lifecycle hooks fire ─────────────────────

  test("onConnect fires on session start, onDisconnect fires on stop", async () => {
    const onConnectSpy = vi.fn();
    const onDisconnectSpy = vi.fn();
    const agent: AgentDef = {
      name: "lifecycle-agent",
      systemPrompt: "You are helpful.",
      greeting: "Hi!",
      maxSteps: 5,
      tools: {},
      onConnect: onConnectSpy,
      onDisconnect: onDisconnectSpy,
    };

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    await vi.waitFor(() => expect(onConnectSpy).toHaveBeenCalledOnce());

    // HookContext should have the right shape
    const hookCtx = onConnectSpy.mock.calls[0]?.[0] as {
      env: Record<string, string>;
      sessionId: string;
    };
    expect(hookCtx.sessionId).toBe("fixture-session");
    expect(hookCtx.env).toBeDefined();

    await ctx.session.stop();
    await vi.waitFor(() => expect(onDisconnectSpy).toHaveBeenCalledOnce());
  });

  // ── onUserTranscript: fires with correct text ──────────────────────────

  test("onUserTranscript hook receives user transcript text", async () => {
    const onUserTranscriptSpy = vi.fn();
    const agent: AgentDef = {
      name: "on-turn-agent",
      systemPrompt: "You are helpful.",
      greeting: "Hi!",
      maxSteps: 5,
      tools: {},
      onUserTranscript: onUserTranscriptSpy,
    };

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await vi.waitFor(() => expect(onUserTranscriptSpy).toHaveBeenCalled());

    const [text, hookCtx] = onUserTranscriptSpy.mock.calls[0] as [
      string,
      { sessionId: string; state: Record<string, unknown> },
    ];
    expect(text.toLowerCase()).toContain("space");
    expect(hookCtx.sessionId).toBe("fixture-session");
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
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // Tool result should contain the error
    const [, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    expect(resultStr).toContain("API key expired");
  });

  // ── resolveTurnConfig / dynamic maxSteps ───────────────────────────────

  test("dynamic maxSteps via resolveTurnConfig limits tool calls", async () => {
    const executeSpy = vi.fn(() => ({ result: "ok" }));
    const agent: AgentDef = {
      name: "maxsteps-agent",
      systemPrompt: "Weather assistant.",
      greeting: "Ask about weather!",
      maxSteps: () => 0, // dynamic: 0 means refuse all tool calls
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: executeSpy,
        },
      },
    };

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // Tool should NOT have been called — maxSteps is 0
    expect(executeSpy).not.toHaveBeenCalled();

    // The result sent back should contain the max-steps refusal
    const [, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    expect(resultStr).toContain("Maximum tool steps reached");
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
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // The result should contain a Zod validation error
    const [, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
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
    await ctx.session.start();

    const h = ctx.mockHandle;

    // Fire an interrupted transcript — should NOT go into conversation history
    h._fire("replyStarted", { replyId: "r1" });
    h._fire("agentTranscript", {
      text: "This was interrupted",
      replyId: "r1",
      itemId: "i1",
      interrupted: true,
    });
    h._fire("replyDone", { status: "interrupted" });
    await flush();

    // Client sees both agent_transcript and cancelled events
    const types = ctx.client.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("agent_transcript");
    expect(types).toContain("cancelled");

    // Fire a non-interrupted transcript — SHOULD go into conversation history
    h._fire("replyStarted", { replyId: "r2" });
    h._fire("agentTranscript", {
      text: "This was completed",
      replyId: "r2",
      itemId: "i2",
      interrupted: false,
    });
    h._fire("replyDone", { status: "completed" });
    await flush();

    // Trigger a tool call to inspect conversation history.
    // userTranscript starts a new turn context.
    h._fire("userTranscript", { itemId: "u1", text: "check" });
    await flush();
    h._fire("replyStarted", { replyId: "r3" });
    h._fire("toolCall", { callId: "c1", name: "check_history", args: { q: "test" } });
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
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // The tool should have seen the user's weather question in messages
    const userMsgs = capturedMessages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content.toLowerCase().includes("weather"))).toBe(true);
  });

  // ── userTranscriptDelta → client with isFinal: false ───────────────────

  test("user transcript deltas forwarded to client as partial transcripts", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    // Manually fire a delta then a final transcript
    ctx.mockHandle._fire("userTranscriptDelta", { text: "Tell me" });
    ctx.mockHandle._fire("userTranscriptDelta", { text: "Tell me a fun" });
    await flush();

    const partials = ctx.client.events.filter(
      (e) =>
        (e as { type: string }).type === "user_transcript_delta" &&
        (e as { isFinal: boolean }).isFinal === false,
    );
    expect(partials.length).toBe(2);
    expect((partials[0] as { text: string }).text).toBe("Tell me");
    expect((partials[1] as { text: string }).text).toBe("Tell me a fun");
  });

  // ── Audio chunks forwarded to client.playAudioChunk ────────────────────

  test("reply.audio events forwarded to client.playAudioChunk", async () => {
    const ctx = createFixtureSession(simpleAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    // Manually fire audio events (replay skips them, so fire directly)
    const audioBytes = new Uint8Array([10, 20, 30, 40]);
    ctx.mockHandle._fire("audio", { audio: audioBytes });
    ctx.mockHandle._fire("audio", { audio: new Uint8Array([50, 60]) });

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
    await ctx.session.start();

    const h = ctx.mockHandle;
    h._fire("replyStarted", { replyId: "r1" });
    h._fire("toolCall", { callId: "c1", name: "get_weather", args: { city: "NYC" } });
    h._fire("toolCall", { callId: "c2", name: "get_weather", args: { city: "LA" } });

    // Wait for both tool calls to execute
    await vi.waitFor(() => {
      const starts = ctx.client.events.filter((e) => (e as { type: string }).type === "tool_call");
      expect(starts.length).toBe(2);
    });

    // Results NOT sent yet — replyDone hasn't fired
    expect(ctx.mockHandle.sendToolResult).not.toHaveBeenCalled();

    // Fire replyDone — should flush both results
    h._fire("replyDone", { status: "completed" });
    await vi.waitFor(() => {
      expect(ctx.mockHandle.sendToolResult).toHaveBeenCalledTimes(2);
    });

    // Verify both results are correct
    const calls = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls as [string, string][];
    const results = calls.map(([, r]) => JSON.parse(r));
    expect(results.some((r) => r.city === "NYC")).toBe(true);
    expect(results.some((r) => r.city === "LA")).toBe(true);
  });
});
