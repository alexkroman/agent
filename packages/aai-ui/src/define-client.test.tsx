// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defineClient } from "./define-client.tsx";
import { delay, installMockWebSocket } from "./lib/test-utils.ts";

describe("defineClient()", () => {
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

  test("throws when target selector does not match", () => {
    function App() {
      return <div>test</div>;
    }
    expect(() =>
      defineClient(App, {
        target: "#nonexistent",
        platformUrl: "http://localhost:3000",
      }),
    ).toThrow("Element not found: #nonexistent");
  });

  test("renders a component into the default #app element", () => {
    function App() {
      return <div class="hello">Hello Mount</div>;
    }
    defineClient(App, { platformUrl: "http://localhost:3000" });

    const el = document.querySelector("#app");
    expect(el?.textContent).toContain("Hello Mount");
  });

  test("returns session, signals, and dispose", () => {
    function App() {
      return <div />;
    }
    const handle = defineClient(App, { platformUrl: "http://localhost:3000" });

    expect(handle.session).toBeDefined();
    expect(handle.signals).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
  });

  test("dispose tears down render and disconnects session", () => {
    function App() {
      return <div>content</div>;
    }
    const handle = defineClient(App, { platformUrl: "http://localhost:3000" });

    const el = document.querySelector("#app");
    expect(el?.textContent).toContain("content");

    handle.dispose();
    expect(el?.textContent).toBe("");
  });

  test("derives platformUrl from location.href when not explicitly provided", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test needs to pass mocked WebSocket
    const WS = globalThis.WebSocket as any;
    const origLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      value: {
        origin: "https://aai-agent.fly.dev",
        pathname: "/alex/ai-takes",
        href: "https://aai-agent.fly.dev/alex/ai-takes",
      },
      writable: true,
      configurable: true,
    });

    try {
      const App = () => <div />;
      const handle = defineClient(App, { WebSocket: WS });
      handle.session.connect();
      await delay(0);
      const ws = mock.lastWs;
      expect(ws).not.toBeNull();
      expect(ws?.url.toString()).toBe("wss://aai-agent.fly.dev/alex/ai-takes/websocket");
      handle.dispose();
    } finally {
      Object.defineProperty(globalThis, "location", {
        value: origLocation,
        writable: true,
        configurable: true,
      });
    }
  });
});
