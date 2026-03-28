// Copyright 2025 the AAI authors. MIT license.
/**
 * Fixture replay tests with a REAL DirectExecutor.
 *
 * Replays recorded AssemblyAI S2S messages (from Kokoro TTS audio) through
 * a real agent session — real tool execution, real Zod arg validation, real
 * middleware pipeline, real hook invocation.
 *
 * This exercises: defineAgent → toAgentConfig → tool schemas → Zod validation
 * → executeToolCall → middleware → session orchestration (reply guards, tool
 * buffering, turnPromise chaining, conversation history).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFixtureSession, flush } from "./_test-utils.ts";
import { defineAgent, defineTool } from "./types.ts";

// ─── Test agents with deterministic tools ────────────────────────────────────

const weatherAgent = defineAgent({
  name: "weather-agent",
  instructions: "You are a weather assistant.",
  greeting: "Ask me about the weather!",
  tools: {
    get_weather: defineTool({
      description: "Get the current weather for a city",
      parameters: z.object({
        city: z.string().describe("City name"),
      }),
      execute: ({ city }) => ({
        city,
        temperature: "72°F",
        condition: "sunny",
        humidity: "45%",
      }),
    }),
  },
});

const simpleAgent = defineAgent({
  name: "simple-agent",
  instructions: "You are a helpful assistant.",
  greeting: "Hi!",
});

const statefulAgent = defineAgent<{ callCount: number }>({
  name: "stateful-agent",
  instructions: "You are helpful.",
  greeting: "Hi!",
  state: () => ({ callCount: 0 }),
  tools: {
    get_weather: defineTool<z.ZodObject<{ city: z.ZodString }>, { callCount: number }>({
      description: "Get weather",
      parameters: z.object({ city: z.string() }),
      execute: ({ city }, ctx) => {
        ctx.state.callCount++;
        return { city, calls: ctx.state.callCount };
      },
    }),
  },
});

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

  test("tool call fixture: client receives tool_call_start with validated args", async () => {
    const ctx = createFixtureSession(weatherAgent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    const toolStart = ctx.client.events.find(
      (e) => (e as { type: string }).type === "tool_call_start",
    ) as { toolName: string; args: Record<string, unknown> } | undefined;
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
    const turns = ctx.client.events.filter((e) => (e as { type: string }).type === "turn");
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

    const chats = ctx.client.events.filter((e) => (e as { type: string }).type === "chat");
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
    expect(types).toContain("transcript");
    expect(types).toContain("turn");
  });

  // ── Middleware: real middleware pipeline exercised ───────────────────────

  test("tool call fixture with middleware: beforeToolCall and afterToolCall fire", async () => {
    const beforeSpy = vi.fn(() => undefined);
    const afterSpy = vi.fn();

    const agent = defineAgent({
      name: "mw-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temp: "72°F" }),
        }),
      },
      middleware: [
        {
          name: "spy-middleware",
          beforeToolCall: beforeSpy,
          afterToolCall: afterSpy,
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // Middleware hooks were called with real tool name and args
    expect(beforeSpy).toHaveBeenCalled();
    expect(afterSpy).toHaveBeenCalled();
  });

  test("middleware can block a tool call", async () => {
    const agent = defineAgent({
      name: "blocking-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: () => "should not run",
        }),
      },
      middleware: [
        {
          name: "blocker",
          beforeToolCall: () => ({ block: true as const, reason: "Blocked by policy" }),
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => {
      const done = ctx.client.events.find(
        (e) => (e as { type: string }).type === "tool_call_done",
      ) as { result: string } | undefined;
      expect(done).toBeDefined();
    });

    // The tool_call_done result should contain the block reason
    const done = ctx.client.events.find(
      (e) => (e as { type: string }).type === "tool_call_done",
    ) as { result: string };
    expect(done.result).toContain("Blocked by policy");

    // The real tool should NOT have been called — sendToolResult still fires
    // because the blocked result is sent back to S2S
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());
    const [, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    expect(resultStr).toContain("Blocked by policy");
  });

  test("middleware can transform tool args", async () => {
    const executeSpy = vi.fn(({ city }: { city: string }) => ({ city, temp: "72°F" }));

    const agent = defineAgent({
      name: "transform-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: executeSpy,
        }),
      },
      middleware: [
        {
          name: "arg-transformer",
          beforeToolCall: (_tool, _args) => ({
            args: { city: "New York" }, // override the city
          }),
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(executeSpy).toHaveBeenCalled());

    // The fixture sends city="San Francisco" but middleware transforms to "New York"
    expect(executeSpy.mock.calls[0]?.[0]).toEqual({ city: "New York" });
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
    expect(types).toContain("chat");
    expect(types).toContain("tts_done");
  });

  // ── Tool schemas: real agent produces correct S2S tool schemas ─────────

  test("real executor builds correct tool schemas from defineAgent", () => {
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

  // ── filterInput: PII redaction before LLM sees the text ────────────────

  test("filterInput middleware transforms user text before onTurn", async () => {
    const onTurnTexts: string[] = [];
    const agent = defineAgent({
      name: "filter-input-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city }),
        }),
      },
      onTurn: (text) => {
        onTurnTexts.push(text);
      },
      middleware: [
        {
          name: "pii-redactor",
          beforeInput: (text) => text.replace(/San Francisco/gi, "[REDACTED]"),
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(onTurnTexts.length).toBeGreaterThan(0));

    // The user said "What is the weather like in San Francisco?"
    // but filterInput should have redacted it before onTurn sees it
    const weatherTurn = onTurnTexts.find((t) => t.includes("weather"));
    expect(weatherTurn).toContain("[REDACTED]");
    expect(weatherTurn).not.toContain("San Francisco");
  });

  // ── beforeTurn: block a turn entirely ──────────────────────────────────

  test("beforeTurn middleware can block a turn", async () => {
    const onTurnSpy = vi.fn();
    const agent = defineAgent({
      name: "block-turn-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      onTurn: onTurnSpy,
      middleware: [
        {
          name: "turn-blocker",
          beforeTurn: () => ({ block: true as const, reason: "Turn blocked by policy" }),
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await flush();
    // Give async hooks time to fire
    await vi.waitFor(() => {
      const chats = ctx.client.events.filter((e) => (e as { type: string }).type === "chat");
      // Greeting chat + blocked reason chat
      expect(chats.length).toBeGreaterThanOrEqual(2);
    });

    // onTurn should NOT have been called — the turn was blocked
    expect(onTurnSpy).not.toHaveBeenCalled();

    // Client should have received the block reason as a chat message
    const chats = ctx.client.events.filter((e) => (e as { type: string }).type === "chat");
    const blockMsg = chats.find((e) =>
      ((e as { text: string }).text ?? "").includes("Turn blocked"),
    );
    expect(blockMsg).toBeDefined();
  });

  // ── afterTurn: fires after a complete reply cycle ──────────────────────

  test("afterTurn middleware fires after reply completes", async () => {
    const afterTurnSpy = vi.fn();
    const agent = defineAgent({
      name: "after-turn-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      middleware: [
        {
          name: "after-turn-logger",
          afterTurn: afterTurnSpy,
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    // afterTurn fires asynchronously after replyDone drains turnPromise
    await vi.waitFor(() => expect(afterTurnSpy).toHaveBeenCalled(), { timeout: 2000 });
  });

  // ── filterOutput: transform agent text before client sees it ───────────

  test("filterOutput middleware transforms agent response text", async () => {
    const agent = defineAgent({
      name: "filter-output-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      middleware: [
        {
          name: "output-censor",
          beforeOutput: (text) => text.replace(/Venus/gi, "[PLANET]"),
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await vi.waitFor(() => {
      const chats = ctx.client.events.filter((e) => (e as { type: string }).type === "chat");
      return expect(chats.length).toBeGreaterThanOrEqual(2);
    });

    // The fixture agent response is "A day on Venus is longer than its year."
    // filterOutput should have replaced "Venus" with "[PLANET]"
    const chats = ctx.client.events
      .filter((e) => (e as { type: string }).type === "chat")
      .map((e) => (e as { text: string }).text);

    // The response chat should contain [PLANET], not Venus
    const responseTxt = chats.find((t) => t.includes("day on"));
    expect(responseTxt).toBeDefined();
    expect(responseTxt).toContain("[PLANET]");
    expect(responseTxt).not.toContain("Venus");

    // Deltas should also be filtered
    const deltas = ctx.client.events
      .filter((e) => (e as { type: string }).type === "chat_delta")
      .map((e) => (e as { text: string }).text);
    for (const d of deltas) {
      expect(d).not.toContain("Venus");
    }
  });

  // ── onConnect / onDisconnect: lifecycle hooks fire ─────────────────────

  test("onConnect fires on session start, onDisconnect fires on stop", async () => {
    const onConnectSpy = vi.fn();
    const onDisconnectSpy = vi.fn();
    const agent = defineAgent({
      name: "lifecycle-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      onConnect: onConnectSpy,
      onDisconnect: onDisconnectSpy,
    });

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

  // ── onTurn: fires with correct text ────────────────────────────────────

  test("onTurn hook receives user transcript text", async () => {
    const onTurnSpy = vi.fn();
    const agent = defineAgent({
      name: "on-turn-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      onTurn: onTurnSpy,
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await vi.waitFor(() => expect(onTurnSpy).toHaveBeenCalled());

    const [text, hookCtx] = onTurnSpy.mock.calls[0] as [
      string,
      { sessionId: string; state: Record<string, unknown> },
    ];
    expect(text.toLowerCase()).toContain("space");
    expect(hookCtx.sessionId).toBe("fixture-session");
  });

  // ── onError: fires when tool throws ────────────────────────────────────

  test("onError fires when a tool throws", async () => {
    const onErrorSpy = vi.fn();
    const agent = defineAgent({
      name: "error-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      onError: onErrorSpy,
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: () => {
            throw new Error("API key expired");
          },
        }),
      },
    });

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
    const agent = defineAgent({
      name: "maxsteps-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      maxSteps: () => 0, // dynamic: 0 means refuse all tool calls
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: executeSpy,
        }),
      },
    });

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

  // ── middleware beforeToolCall: return cached result ─────────────────────

  test("middleware can return a cached result without executing the tool", async () => {
    const executeSpy = vi.fn(() => "should not run");
    const agent = defineAgent({
      name: "cache-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: executeSpy,
        }),
      },
      middleware: [
        {
          name: "cache-middleware",
          beforeToolCall: () => ({
            result: JSON.stringify({ city: "San Francisco", temperature: "68°F", cached: true }),
          }),
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // Tool should NOT have executed — middleware returned cached result
    expect(executeSpy).not.toHaveBeenCalled();

    // The cached result should have been sent to S2S
    const [, resultStr] = vi.mocked(ctx.mockHandle.sendToolResult).mock.calls[0] as [
      string,
      string,
    ];
    const result = JSON.parse(resultStr);
    expect(result.cached).toBe(true);
    expect(result.temperature).toBe("68°F");
  });

  // ── Zod validation: bad args rejected ──────────────────────────────────

  test("Zod validation rejects malformed tool args", async () => {
    const agent = defineAgent({
      name: "strict-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({
            city: z.string(),
            country: z.string(), // required but not in fixture
          }),
          execute: () => "should not run",
        }),
      },
    });

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
    const agent = defineAgent({
      name: "interrupt-history-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      tools: {
        check_history: defineTool({
          description: "Check history",
          parameters: z.object({ q: z.string() }),
          execute: (_args, ctx) => {
            capturedMessages = [...ctx.messages];
            return "ok";
          },
        }),
      },
    });

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

    // Client sees both chat and cancelled events
    const types = ctx.client.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("chat");
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
    const agent = defineAgent({
      name: "history-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }, ctx) => {
            capturedMessages = [...ctx.messages];
            return { city, temp: "72°F" };
          },
        }),
      },
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(ctx.mockHandle.sendToolResult).toHaveBeenCalled());

    // The tool should have seen the user's weather question in messages
    const userMsgs = capturedMessages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content.toLowerCase().includes("weather"))).toBe(true);
  });

  // ── Multiple middleware ordering: before runs forward, after runs reverse ─

  test("multiple middleware: beforeToolCall runs forward, afterToolCall runs reverse", async () => {
    const order: string[] = [];

    const agent = defineAgent({
      name: "ordering-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city }),
        }),
      },
      middleware: [
        {
          name: "first",
          beforeToolCall: () => {
            order.push("before:first");
          },
          afterToolCall: () => {
            order.push("after:first");
          },
        },
        {
          name: "second",
          beforeToolCall: () => {
            order.push("before:second");
          },
          afterToolCall: () => {
            order.push("after:second");
          },
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(order.length).toBeGreaterThanOrEqual(4));

    // beforeToolCall: forward order (first → second)
    const beforeFirst = order.indexOf("before:first");
    const beforeSecond = order.indexOf("before:second");
    expect(beforeFirst).toBeLessThan(beforeSecond);

    // afterToolCall: reverse order (second → first)
    const afterSecond = order.indexOf("after:second");
    const afterFirst = order.indexOf("after:first");
    expect(afterSecond).toBeLessThan(afterFirst);
  });

  // ── chat_delta events pass through filterOutput ────────────────────────

  test("filterOutput applies to chat_delta events too", async () => {
    const filteredDeltas: string[] = [];
    const agent = defineAgent({
      name: "delta-filter-agent",
      instructions: "You are helpful.",
      greeting: "Hi!",
      middleware: [
        {
          name: "delta-filter",
          beforeOutput: (text) => {
            const filtered = text.toUpperCase();
            filteredDeltas.push(filtered);
            return filtered;
          },
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("simple-question-sequence.json");
    await vi.waitFor(() => expect(filteredDeltas.length).toBeGreaterThan(0));

    // All chat_delta events should have uppercased text
    const deltas = ctx.client.events
      .filter((e) => (e as { type: string }).type === "chat_delta")
      .map((e) => (e as { text: string }).text);
    for (const d of deltas) {
      expect(d).toBe(d.toUpperCase());
    }
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
        (e as { type: string }).type === "transcript" &&
        (e as { isFinal: boolean }).isFinal === false,
    );
    expect(partials.length).toBe(2);
    expect((partials[0] as { text: string }).text).toBe("Tell me");
    expect((partials[1] as { text: string }).text).toBe("Tell me a fun");
  });

  // ── afterToolCall receives correct tool name, args, and result ─────────

  test("afterToolCall receives tool name, original args, and result string", async () => {
    const afterCalls: { tool: string; args: Record<string, unknown>; result: string }[] = [];

    const agent = defineAgent({
      name: "after-detail-agent",
      instructions: "Weather assistant.",
      greeting: "Ask about weather!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temp: "72°F" }),
        }),
      },
      middleware: [
        {
          name: "after-detail",
          afterToolCall: (toolName, args, result) => {
            afterCalls.push({
              tool: toolName,
              args: args as Record<string, unknown>,
              result,
            });
          },
        },
      ],
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    ctx.replay("tool-call-sequence.json");
    await vi.waitFor(() => expect(afterCalls.length).toBeGreaterThan(0));

    expect(afterCalls[0]?.tool).toBe("get_weather");
    expect(afterCalls[0]?.args).toEqual({ city: "San Francisco" });
    const result = JSON.parse(afterCalls[0]?.result ?? "{}");
    expect(result.city).toBe("San Francisco");
    expect(result.temp).toBe("72°F");
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
    const agent = defineAgent({
      name: "multi-tool-agent",
      instructions: "Weather assistant.",
      greeting: "Hi!",
      tools: {
        get_weather: defineTool({
          description: "Get weather",
          parameters: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temp: "72°F" }),
        }),
      },
    });

    const ctx = createFixtureSession(agent);
    cleanup = ctx.cleanup;
    await ctx.session.start();

    const h = ctx.mockHandle;
    h._fire("replyStarted", { replyId: "r1" });
    h._fire("toolCall", { callId: "c1", name: "get_weather", args: { city: "NYC" } });
    h._fire("toolCall", { callId: "c2", name: "get_weather", args: { city: "LA" } });

    // Wait for both tool calls to execute
    await vi.waitFor(() => {
      const starts = ctx.client.events.filter(
        (e) => (e as { type: string }).type === "tool_call_start",
      );
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
