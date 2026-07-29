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

  it("renders the sync shell synchronously for an explicit transport: 'sync'", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const handle = client({
      name: "Sync Agent",
      target: "#app",
      platformUrl: "http://localhost:3000",
      transport: "sync",
    });
    // The sync shell is up immediately, and the explicit value skips the lookup.
    expect(container.textContent).toContain("Start listening");
    expect(container.textContent).toContain("Sync Agent");
    expect(fetchSpy).not.toHaveBeenCalled();
    handle.dispose();
    vi.unstubAllGlobals();
  });

  it("swaps to the sync shell when GET client-config declares sync", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("http://localhost:3000/client-config");
        return new Response(
          JSON.stringify({ transport: "sync", name: "Server Name", greeting: "Hi there!" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const handle = client({ target: "#app", platformUrl: "http://localhost:3000" });
    // Optimistic websocket shell first…
    expect(container.textContent).toContain("Start Conversation");
    // …then the declared transport lands (the sync shell's mic toggle).
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Start listening");
    });
    expect(container.textContent).toContain("Server Name");
    expect(container.textContent).toContain("Hi there!");
    handle.dispose();
    vi.unstubAllGlobals();
  });

  it("stays on the websocket shell when the lookup fails", async () => {
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
});
