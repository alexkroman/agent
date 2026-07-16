// Copyright 2026 the AAI authors. MIT license.
// Shared test helpers for the connectS2s specs (split across s2s.test.ts
// and s2s-events.test.ts): WebSocket stub, mock callbacks, and handle setup.

import { vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import type { S2sCallbacks, S2sWebSocket } from "./s2s.ts";
import { connectS2s } from "./s2s.ts";

export function createWebSocketStub() {
  const target = new EventTarget();
  return Object.assign(target, {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: target.addEventListener.bind(target) as S2sWebSocket["addEventListener"],
    emit(event: string, ...args: unknown[]) {
      const builders: Record<string, () => Event> = {
        open: () => new Event("open"),
        message: () => new MessageEvent("message", { data: args[0] }),
        close: () => {
          const ev = new Event("close");
          if (typeof args[0] === "number") Object.assign(ev, { code: args[0] });
          if (typeof args[1] === "string") Object.assign(ev, { reason: args[1] });
          return ev;
        },
        error: () => {
          const msg = args[0] instanceof Error ? args[0].message : String(args[0]);
          const ev = new Event("error");
          Object.defineProperty(ev, "message", { value: msg });
          return ev;
        },
      };
      const build = builders[event];
      if (build) target.dispatchEvent(build());
    },
  });
}

export const s2sConfig = {
  wssUrl: "wss://fake",
  inputSampleRate: 16_000,
  outputSampleRate: 16_000,
};

export function makeMockCallbacks(): S2sCallbacks {
  return {
    onSessionReady: vi.fn(),
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudio: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onSessionExpired: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
}

export function createTestS2s() {
  const raw = createWebSocketStub();
  const createWebSocket = () => {
    setTimeout(() => {
      raw.readyState = 1;
      raw.emit("open");
    }, 0);
    return raw;
  };
  return { raw, createWebSocket, logger: { ...silentLogger } };
}

export async function setupHandle(callbacks?: S2sCallbacks) {
  const { raw, createWebSocket, logger } = createTestS2s();
  const handle = await connectS2s({
    apiKey: "test-key",
    config: s2sConfig,
    createWebSocket,
    callbacks: callbacks ?? makeMockCallbacks(),
    logger,
  });
  return { raw, handle, logger };
}

export type WebSocketStub = ReturnType<typeof createWebSocketStub>;

export function emitMessage(raw: WebSocketStub, payload: unknown): void {
  raw.emit("message", Buffer.from(JSON.stringify(payload)));
}

export function lastSent(raw: WebSocketStub): Record<string, unknown> {
  return JSON.parse(raw.send.mock.calls[0]?.[0] as string);
}

export function errorArg(callbacks: S2sCallbacks): Error {
  return (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}
