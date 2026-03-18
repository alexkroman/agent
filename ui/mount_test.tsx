// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { delay, withMountEnv } from "./_test_utils.ts";
import { mount } from "./mount.tsx";

describe("mount()", () => {
  test(
    "throws when target selector does not match",
    withMountEnv(() => {
      function App() {
        return <div>test</div>;
      }
      expect(() =>
        mount(App, {
          target: "#nonexistent",
          platformUrl: "http://localhost:3000",
        }),
      ).toThrow("Element not found: #nonexistent");
    }),
  );

  test(
    "renders a component into the default #app element",
    withMountEnv(() => {
      function App() {
        return <div class="hello">Hello Mount</div>;
      }
      mount(App, { platformUrl: "http://localhost:3000" });

      const el = globalThis.document.querySelector("#app");
      if (!el) throw new Error("Expected #app element to exist");
      expect(el.textContent ?? "").toContain("Hello Mount");
    }),
  );

  test(
    "returns session, signals, and dispose",
    withMountEnv(() => {
      function App() {
        return <div />;
      }
      const handle = mount(App, { platformUrl: "http://localhost:3000" });

      expect(handle.session !== undefined).toBe(true);
      expect(handle.signals !== undefined).toBe(true);
      expect(typeof handle.dispose).toBe("function");
    }),
  );

  test(
    "dispose tears down render and disconnects session",
    withMountEnv(() => {
      function App() {
        return <div>content</div>;
      }
      const handle = mount(App, { platformUrl: "http://localhost:3000" });

      const el = globalThis.document.querySelector("#app");
      if (!el) throw new Error("Expected #app element to exist");
      expect(el.textContent ?? "").toContain("content");

      handle.dispose();
      expect(el.textContent).toBe("");
    }),
  );

  test(
    "derives platformUrl from location.href when not explicitly provided",
    withMountEnv(async (mock) => {
      const g = globalThis as unknown as Record<string, unknown>;
      g.location = {
        origin: "https://aai-agent.fly.dev",
        pathname: "/alex/ai-takes",
        href: "https://aai-agent.fly.dev/alex/ai-takes",
      };
      const App = () => <div />;
      const handle = mount(App);
      handle.session.connect();
      await delay(0);
      const ws = mock.lastWs;
      if (!ws) throw new Error("Expected WebSocket to be created");
      expect(ws.url.toString()).toBe("wss://aai-agent.fly.dev/alex/ai-takes/websocket");
      handle.dispose();
    }),
  );
});
