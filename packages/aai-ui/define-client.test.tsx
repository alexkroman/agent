// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock createSessionCore to avoid real WebSocket connections.
vi.mock("./session-core.ts", () => {
  const snapshot = {
    state: "disconnected" as const,
    messages: [],
    toolCalls: [],
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: false,
    running: false,
  };
  return {
    createSessionCore: vi.fn(() => ({
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      connect: vi.fn(),
      cancel: vi.fn(),
      resetState: vi.fn(),
      reset: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      toggle: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    })),
  };
});

import { type ToolDisplayConfig, useToolConfig } from "./components/tool-config-context.ts";
import { client } from "./define-client.tsx";
import { createSessionCore } from "./session-core.ts";

describe("client", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.textContent = "";
    vi.clearAllMocks();
  });

  it("throws when target selector does not match", () => {
    expect(() =>
      client({ name: "Test", target: "#nonexistent", platformUrl: "http://localhost:3000" }),
    ).toThrow("Element not found: #nonexistent");
  });

  it("renders with config-only (tier 1)", () => {
    const handle = client({
      name: "Test Agent",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    expect(handle.session).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
    expect(container.childNodes.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("renders with custom component (tier 2)", () => {
    function MyApp() {
      return createElement("div", { "data-testid": "custom" }, "Custom");
    }
    const handle = client({
      component: MyApp,
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    expect(container.querySelector("[data-testid='custom']")).not.toBeNull();
    handle.dispose();
  });

  it("dispose unmounts and disconnects", () => {
    const handle = client({
      name: "Test",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    handle.dispose();
    expect(container.childNodes.length).toBe(0);
  });

  it("dispose invokes the session core's Symbol.dispose", () => {
    const handle = client({
      name: "Test",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    const core = vi.mocked(createSessionCore).mock.results[0]?.value as {
      [Symbol.dispose]: ReturnType<typeof vi.fn>;
    };
    expect(core[Symbol.dispose]).not.toHaveBeenCalled();
    handle.dispose();
    expect(core[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("Symbol.dispose aliases dispose", () => {
    const handle = client({
      name: "Test",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    const disposeSpy = vi.spyOn(handle, "dispose");
    handle[Symbol.dispose]();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("accepts an HTMLElement as target", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const handle = client({ target: el, platformUrl: "http://localhost:3000" });
    expect(el.childNodes.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("uses the server-declared name on the chat shell when none is passed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ name: "Server Name" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const handle = client({ target: "#app", platformUrl: "http://localhost:3000" });
    await vi.waitFor(() => expect(container.textContent).toContain("Server Name"));
    handle.dispose();
    vi.unstubAllGlobals();
  });

  it("stays on the chat shell when the lookup fails", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const handle = client({ name: "Test", target: "#app", platformUrl: "http://localhost:3000" });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(container.textContent).toContain("Start Conversation");
    expect(container.textContent).not.toContain("HTTP turns");
    handle.dispose();
    vi.unstubAllGlobals();
  });

  it("derives platformUrl from location.href when not provided", () => {
    vi.stubGlobal("location", {
      origin: "https://example.com",
      pathname: "/agent/",
      href: "https://example.com/agent/",
    });
    const mockedCreateSessionCore = vi.mocked(createSessionCore);
    const handle = client({ name: "Test", target: container });
    expect(mockedCreateSessionCore).toHaveBeenCalledWith(
      expect.objectContaining({ platformUrl: "https://example.com/agent/" }),
    );
    handle.dispose();
    vi.unstubAllGlobals();
  });

  /**
   * `name` alongside `component` used to be `never`, which failed with
   * "Type 'string' is not assignable to type 'undefined'" — a message that
   * explains nothing, on the most natural thing to write. Two different
   * models wrote it and each spent a build round on it. It is allowed now,
   * and it means something: the page title, since a custom component has no
   * shell header to show it in.
   */
  it("uses name as the page title, including with a custom component", () => {
    const before = document.title;
    const handle = client({
      name: "Pizza Palace",
      component: () => null,
      target: container,
    });
    expect(document.title).toBe("Pizza Palace");
    handle.dispose();
    document.title = before;
  });

  it("leaves the page title alone when no name is given", () => {
    document.title = "Shipped by the HTML";
    const handle = client({ component: () => null, target: container });
    expect(document.title).toBe("Shipped by the HTML");
    handle.dispose();
  });

  /**
   * `tools` alongside `component` used to be `never` — the same shape of bug
   * as `name` above, and found the same way: four starters in one eval run
   * wrote `client({ component, tools })` and each lost a build round to
   * "Type '{ … }' is not assignable to type 'undefined'".
   *
   * It was never a default-shell option like `sidebar`. The provider wraps
   * whichever root is rendered, and `ToolCallBlock` reads it — so a custom
   * component gets the labels the moment it renders `MessageList` or
   * `ChatView`. This asserts the value actually arrives, rather than only
   * that the type now permits it.
   */
  it("passes tool display config to a custom component (tier 2)", () => {
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    const handle = client({
      component: Probe,
      tools: { add_pizza: { label: "Adding pizza", icon: "🍕" } },
      target: container,
    });
    expect(seen).toEqual({ add_pizza: { label: "Adding pizza", icon: "🍕" } });
    handle.dispose();
  });

  it("defaults tool display config to empty for a custom component", () => {
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    const handle = client({ component: Probe, target: container });
    expect(seen).toEqual({});
    handle.dispose();
  });
});
