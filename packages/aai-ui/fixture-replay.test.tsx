// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * Fixture replay tests for all UI components.
 *
 * Replays server→client message sequences through the real session/signal
 * pipeline with a mock WebSocket. Verifies that every component renders
 * correctly as the session progresses through greeting → user speech →
 * agent response → tool calls → errors → barge-in → multi-turn.
 */

import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { flush, loadFixture, replayFixture, setupSignalsEnv } from "./_test-utils.ts";
import { App } from "./components/app.tsx";
import { SessionProvider } from "./signals.ts";

// ─── Test harness ────────────────────────────────────────────────────────────

let env: ReturnType<typeof setupSignalsEnv>;

function renderApp() {
  return render(
    <SessionProvider value={env.signals}>
      <App />
    </SessionProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("fixture replay: greeting session", () => {
  beforeEach(() => {
    env = setupSignalsEnv();
  });
  afterEach(() => env.restore());

  test("config message sets session to ready state", async () => {
    env.signals.start();
    await flush();

    env.send({
      type: "config",
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
      sessionId: "sess_fixture_001",
    });

    expect(env.session.state.value).toBe("ready");
  });

  test("greeting chat message appears in messages", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "greeting-session.json");

    const msgs = env.session.messages.value;
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.content).toBe("Hello! How can I help you today?");
    expect(msgs[0]?.role).toBe("assistant");
  });

  test("chat_delta accumulates in agentUtterance during streaming", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("greeting-session.json");
    // Send config
    env.send(fixture[0] as Record<string, unknown>);
    await flush();

    // Send first delta — "Hello"
    env.send(fixture[3] as Record<string, unknown>);
    const after1 = env.session.agentUtterance.value;
    expect(after1).toContain("Hello");

    // Send second delta — appends "! How can"
    env.send(fixture[4] as Record<string, unknown>);
    const after2 = env.session.agentUtterance.value;
    expect(after2).toContain("How can");

    // After final chat, agentUtterance clears
    env.send(fixture[7] as Record<string, unknown>);
    expect(env.session.agentUtterance.value).toBe(null);
  });

  test("tts_done transitions state to listening", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "greeting-session.json");

    // After tts_done, state should be "listening" (ready to hear user)
    expect(env.session.state.value).toBe("listening");
  });
});

describe("fixture replay: simple conversation", () => {
  beforeEach(() => {
    env = setupSignalsEnv();
  });
  afterEach(() => env.restore());

  test("user speech → transcript → turn → agent response accumulates messages", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "simple-conversation.json");

    const msgs = env.session.messages.value;
    expect(msgs.length).toBe(3); // greeting + user + answer
    expect(msgs[0]).toEqual({ role: "assistant", content: "Hi there!" });
    expect(msgs[1]).toEqual({ role: "user", content: "Tell me a fun fact about space." });
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: "A day on Venus is longer than its year.",
    });
  });

  test("partial transcripts update userUtterance progressively", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("simple-conversation.json");

    // Send config + greeting
    for (let i = 0; i <= 2; i++) env.send(fixture[i] as Record<string, unknown>);
    await flush();

    // speech_started
    env.send(fixture[3] as Record<string, unknown>);
    expect(env.session.userUtterance.value).toBe("");

    // partial transcript
    env.send(fixture[4] as Record<string, unknown>); // "Tell me"
    expect(env.session.userUtterance.value).toBe("Tell me");

    env.send(fixture[5] as Record<string, unknown>); // "Tell me a fun"
    expect(env.session.userUtterance.value).toBe("Tell me a fun");

    // turn clears userUtterance
    env.send(fixture[8] as Record<string, unknown>); // turn
    expect(env.session.userUtterance.value).toBe(null);
  });

  test("turn event transitions state to thinking", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("simple-conversation.json");
    // Send up through the turn event
    for (let i = 0; i <= 8; i++) {
      env.send(fixture[i] as Record<string, unknown>);
      await flush();
    }

    expect(env.session.state.value).toBe("thinking");
  });

  test("renders messages in App component", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "simple-conversation.json");

    const r = renderApp();
    expect(screen.getByText("Hi there!")).toBeDefined();
    expect(screen.getByText("Tell me a fun fact about space.")).toBeDefined();
    expect(screen.getByText("A day on Venus is longer than its year.")).toBeDefined();
    r.unmount();
  });
});

describe("fixture replay: tool call flow", () => {
  beforeEach(() => {
    env = setupSignalsEnv();
  });
  afterEach(() => env.restore());

  test("tool_call_start creates pending tool call", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("tool-call-flow.json");
    // Send through tool_call_start
    for (let i = 0; i <= 8; i++) {
      env.send(fixture[i] as Record<string, unknown>);
      await flush();
    }

    const toolCalls = env.session.toolCalls.value;
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    expect(toolCalls[0]?.status).toBe("pending");
    expect(toolCalls[0]?.args).toEqual({ city: "San Francisco" });
  });

  test("tool_call_done updates status and adds result", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("tool-call-flow.json");
    // Send through tool_call_done
    for (let i = 0; i <= 9; i++) {
      env.send(fixture[i] as Record<string, unknown>);
      await flush();
    }

    const toolCalls = env.session.toolCalls.value;
    expect(toolCalls[0]?.status).toBe("done");
    expect(toolCalls[0]?.result).toContain("72°F");
  });

  test("tool call renders in MessageList with tool name", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "tool-call-flow.json");

    const r = renderApp();
    // Tool call block should show the tool name
    expect(screen.getByText("get_weather")).toBeDefined();
    // Messages should be present
    expect(screen.getByText("What is the weather like in San Francisco?")).toBeDefined();
    expect(screen.getByText("The weather in San Francisco is sunny at 72°F.")).toBeDefined();
    r.unmount();
  });

  test("full tool call flow produces correct message history", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "tool-call-flow.json");

    const msgs = env.session.messages.value;
    expect(msgs.length).toBe(3); // greeting + user question + agent answer
    expect(msgs[1]?.content).toBe("What is the weather like in San Francisco?");
    expect(msgs[2]?.content).toBe("The weather in San Francisco is sunny at 72°F.");
  });
});

describe("fixture replay: error recovery", () => {
  beforeEach(() => {
    env = setupSignalsEnv();
  });
  afterEach(() => env.restore());

  test("error event sets error state", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "error-recovery.json");

    expect(env.session.state.value).toBe("error");
    expect(env.session.error.value).toEqual({
      code: "stt",
      message: "Speech recognition failed",
    });
  });

  test("error stops the running signal", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "error-recovery.json");

    expect(env.signals.running.value).toBe(false);
  });

  test("error banner renders in App", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "error-recovery.json");

    const r = renderApp();
    expect(screen.getByText("Speech recognition failed")).toBeDefined();
    expect(screen.getByText("Resume")).toBeDefined();
    r.unmount();
  });
});

describe("fixture replay: barge-in (cancellation)", () => {
  beforeEach(() => {
    env = setupSignalsEnv();
  });
  afterEach(() => env.restore());

  test("cancelled event clears agent utterance and resets to listening", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("barge-in.json");
    // Send through the cancelled event (index 10)
    for (let i = 0; i <= 10; i++) {
      env.send(fixture[i] as Record<string, unknown>);
      await flush();
    }

    // After cancelled, agent utterance should be cleared
    expect(env.session.agentUtterance.value).toBe(null);
    expect(env.session.state.value).toBe("listening");
  });

  test("full barge-in flow: interrupted response → new question → answer", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "barge-in.json");

    const msgs = env.session.messages.value;
    // greeting + first user turn + second user turn + final answer
    expect(msgs.length).toBe(4);
    expect(msgs[1]?.content).toBe("What about");
    expect(msgs[2]?.content).toBe("Actually never mind");
    expect(msgs[3]?.content).toBe("No problem!");
  });

  test("cancelled chat_delta text clears from agentUtterance, not persisted in messages", async () => {
    env.signals.start();
    await flush();

    const fixture = loadFixture("barge-in.json");

    // Send events up through the two chat_deltas (before cancelled)
    // config[0], chat[1], tts_done[2], speech[3], transcript[4], speech[5],
    // turn[6], chat_delta[7], chat_delta[8]
    for (let i = 0; i <= 8; i++) {
      env.send(fixture[i] as Record<string, unknown>);
      await flush();
    }

    // agentUtterance should have accumulated delta text
    expect(env.session.agentUtterance.value).toContain("Well,");

    // Now send cancelled[9]
    env.send(fixture[9] as Record<string, unknown>);
    await flush();

    // agentUtterance should be cleared
    expect(env.session.agentUtterance.value).toBe(null);

    // Messages should NOT contain the delta text (deltas never go to messages)
    const allContent = env.session.messages.value.map((m) => m.content);
    expect(allContent.every((c) => !c.includes("Well,"))).toBe(true);
  });
});

describe("fixture replay: multi-turn with tools", () => {
  beforeEach(() => {
    env = setupSignalsEnv();
  });
  afterEach(() => env.restore());

  test("two turns with tool calls accumulate correctly", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "multi-turn-with-tools.json");

    const msgs = env.session.messages.value;
    // greeting + user1 + answer1 + user2 + answer2
    expect(msgs.length).toBe(5);
    expect(msgs[0]?.content).toContain("weather and more");
    expect(msgs[1]?.content).toBe("Weather in NYC?");
    expect(msgs[2]?.content).toContain("65°F");
    expect(msgs[3]?.content).toBe("And in London?");
    expect(msgs[4]?.content).toContain("55°F");
  });

  test("both tool calls tracked with correct names and results", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "multi-turn-with-tools.json");

    const toolCalls = env.session.toolCalls.value;
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    expect(toolCalls[0]?.args).toEqual({ city: "New York" });
    expect(toolCalls[0]?.status).toBe("done");
    expect(toolCalls[1]?.toolName).toBe("get_weather");
    expect(toolCalls[1]?.args).toEqual({ city: "London" });
    expect(toolCalls[1]?.status).toBe("done");
  });

  test("renders full multi-turn conversation in App", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "multi-turn-with-tools.json");

    const r = renderApp();
    expect(screen.getByText("Weather in NYC?")).toBeDefined();
    expect(screen.getByText("And in London?")).toBeDefined();
    // Tool call blocks
    const toolBlocks = screen.getAllByText("get_weather");
    expect(toolBlocks.length).toBe(2);
    r.unmount();
  });

  test("final state is listening after last tts_done", async () => {
    env.signals.start();
    await flush();

    await replayFixture(env, "multi-turn-with-tools.json");

    expect(env.session.state.value).toBe("listening");
  });
});
