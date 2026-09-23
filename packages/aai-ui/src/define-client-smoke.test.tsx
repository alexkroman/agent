// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

// Wiring smoke test: unlike define-client.test.tsx this file does NOT mock
// createBrowserSession — the real mountClient() → session-core → WebSocket path runs,
// with only the socket constructor injected. The shared `MockWebSocket` never
// opens or errors on its own, so the socket stays CONNECTING throughout.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockWebSocket, recordingWebSocketClass } from "./_session-core-test-utils.ts";
import { mountClient } from "./define-client.tsx";

describe("mountClient (unmocked session core)", () => {
  let container: HTMLElement;
  let sockets: MockWebSocket[];

  beforeEach(() => {
    sockets = [];
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("clicking the start button opens a socket to the /websocket endpoint", () => {
    const handle = mountClient({
      name: "Smoke Test",
      target: "#app",
      platformUrl: "http://test.local",
      WebSocket: recordingWebSocketClass((socket) => {
        sockets.push(socket);
      }),
    });
    try {
      // The default shell mounts on the StartScreen; no socket yet.
      expect(sockets).toHaveLength(0);
      const button = container.querySelector("button");
      expect(button?.textContent).toBe("Start Conversation");

      act(() => {
        button?.click();
      });

      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toBe("ws://test.local/websocket");
    } finally {
      handle.dispose();
    }
  });
});
