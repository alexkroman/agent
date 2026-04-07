// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * UI integration tests.
 *
 * Test the full lifecycle: defineClient → connect → server events → signal/component
 * updates → unmount cleanup. Uses mock WebSocket to simulate server messages.
 */
import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMockSession, flush, installMockWebSocket, setupSignalsEnv } from "./_test-utils.ts";
import { App } from "./components/app.tsx";
import { defineClient } from "./define-client.tsx";
import { SessionProvider, useSession } from "./signals.ts";

// --- Mount lifecycle integration ---

describe("UI integration: defineClient lifecycle", () => {
  let mock: ReturnType<typeof installMockWebSocket>;

  beforeEach(() => {
    mock = installMockWebSocket();
    document.getElementById("app")?.remove();
    const app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
  });

  afterEach(() => {
    mock.restore();
  });

  test("defineClient → connect → receive ready → state becomes listening", async () => {
    function TestApp() {
      const s = useSession();
      return <div data-testid="state">{s.state.value}</div>;
    }

    const handle = defineClient(TestApp, {
      platformUrl: "http://localhost:3000",
      WebSocket: globalThis.WebSocket,
    });

    // Start the session
    handle.session.start();
    await flush();

    // Mock WS should be created
    const ws = mock.lastWs;
    expect(ws).not.toBeNull();

    // Simulate server sending ready config
    ws?.simulateMessage(
      JSON.stringify({
        type: "ready",
        audioFormat: "pcm_s16le",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }),
    );
    await flush();

    // State is "ready" after receiving config (transitions to "listening"
    // once audio capture starts, which requires real AudioContext)
    expect(handle.session.state.value).toBe("ready");
    handle.dispose();
  });

  test("defineClient → dispose cleans up DOM and disconnects", async () => {
    function TestApp() {
      return <div>mounted</div>;
    }

    const handle = defineClient(TestApp, {
      platformUrl: "http://localhost:3000",
      WebSocket: globalThis.WebSocket,
    });
    const el = document.querySelector("#app");
    expect(el?.textContent).toContain("mounted");

    handle.dispose();
    expect(el?.textContent).toBe("");
  });

  test("defineClient returns session handle", () => {
    const handle = defineClient(() => <div />, {
      platformUrl: "http://localhost:3000",
      WebSocket: globalThis.WebSocket,
    });
    expect(handle.session).toBeDefined();
    expect(handle.session.started.value).toBe(false);
    expect(typeof handle.dispose).toBe("function");
    handle.dispose();
  });
});

// --- Session signals + component tree integration ---

describe("UI integration: signals → component rendering", () => {
  let env: ReturnType<typeof setupSignalsEnv>;

  beforeEach(() => {
    env = setupSignalsEnv();
  });

  afterEach(() => {
    env.restore();
  });

  test("start → connect → events flow through to session", async () => {
    // Start session
    env.session.start();
    await flush();

    expect(env.session.started.value).toBe(true);
    expect(env.session.running.value).toBe(true);
    expect(env.mock.lastWs).not.toBeNull();

    // Simulate ready — state is "ready" (transitions to "listening" with real audio)
    env.send({
      type: "ready",
      audioFormat: "pcm_s16le",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
    expect(env.session.state.value).toBe("ready");

    // Simulate user_transcript (user said something)
    env.send({ type: "user_transcript", text: "hello world" });
    expect(env.session.state.value).toBe("thinking");
    expect(env.session.userUtterance.value).toBe(null);
    expect(env.session.messages.value).toEqual([{ role: "user", content: "hello world" }]);

    // Simulate agent_transcript response
    env.send({ type: "agent_transcript", text: "Hi there!" });
    expect(env.session.messages.value).toHaveLength(2);
    expect(env.session.messages.value[1]).toEqual({
      role: "assistant",
      content: "Hi there!",
    });

    env.session.disconnect();
  });

  test("error event sets error state and stops running", async () => {
    await env.connect();
    expect(env.session.running.value).toBe(true);

    env.send({ type: "error", code: "stt", message: "Speech recognition failed" });
    expect(env.session.state.value).toBe("error");
    expect(env.session.error.value).toEqual({
      code: "stt",
      message: "Speech recognition failed",
    });
    expect(env.session.running.value).toBe(false);

    env.session.disconnect();
  });

  test("toggle disconnects and reconnects", async () => {
    env.session.start();
    await flush();
    expect(env.session.running.value).toBe(true);

    // Toggle off
    env.session.toggle();
    expect(env.session.running.value).toBe(false);

    // Toggle back on
    env.session.toggle();
    await flush();
    expect(env.session.running.value).toBe(true);

    env.session.disconnect();
  });

  test("reset sends reset message to server", async () => {
    await env.connect();

    env.session.reset();
    const sent = env.mock.lastWs?.sent.filter((d): d is string => typeof d === "string") ?? [];
    const resetMsg = sent.find((s) => JSON.parse(s).type === "reset");
    expect(resetMsg).toBeDefined();

    env.session.disconnect();
  });
});

// --- Component rendering integration ---

describe("UI integration: App component full flow", () => {
  test("App shows Start button, then chat view after start", () => {
    const session = createMockSession({ started: false });

    const { rerender } = render(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );

    // Initially shows start screen
    expect(screen.getByText("Start")).toBeDefined();

    // Simulate starting
    session.started.value = true;
    session.state.value = "listening";
    rerender(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );

    // Now shows chat view
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();
    expect(screen.queryByText("Start")).toBeNull();
  });

  test("App shows messages and error state", () => {
    const session = createMockSession({
      started: true,
      state: "error",
      running: false,
      messages: [
        { role: "user", content: "What time is it?" },
        { role: "assistant", content: "It's 3pm." },
      ],
      error: { code: "connection", message: "WebSocket closed" },
    });

    render(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );

    expect(screen.getByText("What time is it?")).toBeDefined();
    expect(screen.getByText("It's 3pm.")).toBeDefined();
    expect(screen.getByText("WebSocket closed")).toBeDefined();
  });

  test("App shows Resume button when not running", () => {
    const session = createMockSession({
      started: true,
      state: "disconnected",
      running: false,
    });

    render(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );

    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("multiple messages render in DOM order", () => {
    const session = createMockSession({
      started: true,
      state: "listening",
      running: true,
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Second message" },
        { role: "user", content: "Third message" },
      ],
    });

    render(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );

    const first = screen.getByText("First message");
    const second = screen.getByText("Second message");
    const third = screen.getByText("Third message");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
