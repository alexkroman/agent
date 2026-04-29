// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const PLATFORM_URL = "http://localhost:3000";

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
      client({ name: "Test", target: "#nonexistent", platformUrl: PLATFORM_URL }),
    ).toThrow("Element not found: #nonexistent");
  });

  it("renders with config-only (tier 1)", () => {
    const handle = client({ name: "Test Agent", target: "#app", platformUrl: PLATFORM_URL });
    expect(handle.session).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
    expect(container.childNodes.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("renders with custom component (tier 2)", () => {
    function MyApp() {
      return createElement("div", { "data-testid": "custom" }, "Custom");
    }
    const handle = client({ component: MyApp, target: "#app", platformUrl: PLATFORM_URL });
    expect(container.querySelector("[data-testid='custom']")).not.toBeNull();
    handle.dispose();
  });

  it("dispose unmounts and disconnects", () => {
    const handle = client({ name: "Test", target: "#app", platformUrl: PLATFORM_URL });
    handle.dispose();
    expect(container.childNodes.length).toBe(0);
  });

  it("Symbol.dispose aliases dispose", () => {
    const handle = client({ name: "Test", target: "#app", platformUrl: PLATFORM_URL });
    const disposeSpy = vi.spyOn(handle, "dispose");
    handle[Symbol.dispose]();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("accepts an HTMLElement as target", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const handle = client({ target: el, platformUrl: PLATFORM_URL });
    expect(el.childNodes.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("derives platformUrl from location.href when not provided", () => {
    vi.stubGlobal("location", {
      origin: "https://example.com",
      pathname: "/agent/",
      href: "https://example.com/agent/",
    });
    const handle = client({ name: "Test", target: container });
    expect(vi.mocked(createSessionCore)).toHaveBeenCalledWith(
      expect.objectContaining({ platformUrl: "https://example.com/agent/" }),
    );
    handle.dispose();
    vi.unstubAllGlobals();
  });
});
