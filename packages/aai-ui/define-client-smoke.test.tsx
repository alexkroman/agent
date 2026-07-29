// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

// Wiring smoke test: unlike define-client.test.tsx this file does NOT mock
// createSessionCore — the real client() → session-core → WebSocket path runs,
// with only the socket constructor injected.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client } from "./define-client.tsx";
import type { WebSocketConstructor } from "./types.ts";

/** Minimal inert WebSocket stand-in that records constructed URLs. */
class MockSocket {
  static instances: MockSocket[] = [];
  url: string;
  binaryType = "blob";
  readyState = 0; // CONNECTING: never opens, never errors
  constructor(url: string | URL) {
    this.url = String(url);
    MockSocket.instances.push(this);
  }
  addEventListener(_type: string, _cb: (ev: unknown) => void, _opts?: unknown) {
    /* noop */
  }
  removeEventListener(_type: string, _cb: (ev: unknown) => void) {
    /* noop */
  }
  send(_data: unknown) {
    /* noop */
  }
  close() {
    this.readyState = 3;
  }
}

describe("client (unmocked session core)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    MockSocket.instances = [];
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("clicking the start button opens a socket to the /websocket endpoint", () => {
    const handle = client({
      name: "Smoke Test",
      target: "#app",
      platformUrl: "http://test.local",
      WebSocket: MockSocket as unknown as WebSocketConstructor,
    });
    try {
      // The default shell mounts on the StartScreen; no socket yet.
      expect(MockSocket.instances).toHaveLength(0);
      const button = container.querySelector("button");
      expect(button?.textContent).toBe("Start Conversation");

      act(() => {
        button?.click();
      });

      expect(MockSocket.instances).toHaveLength(1);
      expect(MockSocket.instances[0]?.url).toBe("ws://test.local/websocket");
    } finally {
      handle.dispose();
    }
  });
});
