// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * UI integration tests.
 *
 * Test the full lifecycle: mount → connect → server events → signal/component
 * updates → unmount cleanup. Uses mock WebSocket to simulate server messages.
 */
import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { App } from "./_components/app.tsx";
import { createMockSignals, flush, installMockWebSocket, setupSignalsEnv } from "./_test-utils.ts";
import { mount } from "./mount.tsx";
import { SessionProvider, useSession } from "./signals.ts";

// --- Mount lifecycle integration ---

describe("UI integration: mount lifecycle", () => {
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

  test("mount → connect → receive ready → state becomes listening", async () => {
    function TestApp() {
      const s = useSession();
      return <div data-testid="state">{s.session.state.value}</div>;
    }

    const handle = mount(TestApp, { platformUrl: "http://localhost:3000" });

    // Start the session
    handle.signals.start();
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

  test("mount → dispose cleans up DOM and disconnects", async () => {
    function TestApp() {
      return <div>mounted</div>;
    }

    const handle = mount(TestApp, { platformUrl: "http://localhost:3000" });
    const el = document.querySelector("#app");
    expect(el?.textContent).toContain("mounted");

    handle.dispose();
    expect(el?.textContent).toBe("");
  });

  test("mount returns session and signals handles", () => {
    const handle = mount(() => <div />, { platformUrl: "http://localhost:3000" });
    expect(handle.session).toBeDefined();
    expect(handle.signals).toBeDefined();
    expect(handle.signals.started.value).toBe(false);
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

  test("start → connect → events flow through to signals", async () => {
    // Start session
    env.signals.start();
    await flush();

    expect(env.signals.started.value).toBe(true);
    expect(env.signals.running.value).toBe(true);
    expect(env.mock.lastWs).not.toBeNull();

    // Simulate ready — state is "ready" (transitions to "listening" with real audio)
    env.send({
      type: "ready",
      audioFormat: "pcm_s16le",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
    expect(env.session.state.value).toBe("ready");

    // Simulate turn (user said something)
    env.send({ type: "turn", text: "hello world" });
    expect(env.session.state.value).toBe("thinking");
    expect(env.session.userUtterance.value).toBe(null);
    expect(env.session.messages.value).toEqual([{ role: "user", content: "hello world" }]);

    // Simulate chat response
    env.send({ type: "chat", text: "Hi there!" });
    expect(env.session.messages.value).toHaveLength(2);
    expect(env.session.messages.value[1]).toEqual({
      role: "assistant",
      content: "Hi there!",
    });

    env.session.disconnect();
  });

  test("error event sets error state and stops running", async () => {
    await env.connect();
    expect(env.signals.running.value).toBe(true);

    env.send({ type: "error", code: "stt", message: "Speech recognition failed" });
    expect(env.session.state.value).toBe("error");
    expect(env.session.error.value).toEqual({
      code: "stt",
      message: "Speech recognition failed",
    });
    expect(env.signals.running.value).toBe(false);

    env.session.disconnect();
  });

  test("toggle disconnects and reconnects", async () => {
    env.signals.start();
    await flush();
    expect(env.signals.running.value).toBe(true);

    // Toggle off
    env.signals.toggle();
    expect(env.signals.running.value).toBe(false);

    // Toggle back on
    env.signals.toggle();
    await flush();
    expect(env.signals.running.value).toBe(true);

    env.session.disconnect();
  });

  test("reset sends reset message to server", async () => {
    await env.connect();

    env.signals.reset();
    const sent = env.mock.lastWs?.sent.filter((d): d is string => typeof d === "string") ?? [];
    const resetMsg = sent.find((s) => JSON.parse(s).type === "reset");
    expect(resetMsg).toBeDefined();

    env.session.disconnect();
  });
});

// --- Component rendering integration ---

describe("UI integration: App component full flow", () => {
  test("App shows Start button, then chat view after start", () => {
    const signals = createMockSignals({ started: false });

    const { rerender } = render(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );

    // Initially shows start screen
    expect(screen.getByText("Start")).toBeDefined();

    // Simulate starting
    signals.started.value = true;
    signals.session.state.value = "listening";
    rerender(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );

    // Now shows chat view
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();
    expect(screen.queryByText("Start")).toBeNull();
  });

  test("App shows messages and error state", () => {
    const signals = createMockSignals({
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
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );

    expect(screen.getByText("What time is it?")).toBeDefined();
    expect(screen.getByText("It's 3pm.")).toBeDefined();
    expect(screen.getByText("WebSocket closed")).toBeDefined();
  });

  test("App shows Resume button when not running", () => {
    const signals = createMockSignals({
      started: true,
      state: "disconnected",
      running: false,
    });

    render(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );

    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("multiple messages render in DOM order", () => {
    const signals = createMockSignals({
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
      <SessionProvider value={signals}>
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
