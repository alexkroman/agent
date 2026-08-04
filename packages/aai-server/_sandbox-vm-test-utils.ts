// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared test helpers for the sandbox test files: a fake guest WebSocket
 * (the seam `rpc-transport.ts` speaks to) and the agent-spawn options base.
 */

import type { RpcWebSocket } from "./rpc-transport.ts";
import type { AgentSpawnOptions } from "./sandbox-vm.ts";

/** A fake guest endpoint: what the host sent, plus a way to answer. */
export type FakeGuestSocket = {
  ws: RpcWebSocket;
  /** Raw JSON frames the host sent to the guest, in order. */
  writtenLines: string[];
  /** Parsed frames the host sent to the guest. */
  sentMessages(): Record<string, unknown>[];
  /** Deliver one message from the guest to the host. */
  receive(msg: unknown): void;
  /** Observe every frame the host sends (for auto-responders). */
  onSend(cb: (msg: Record<string, unknown>) => void): void;
  /** Close the socket from the guest side. */
  close(): void;
};

export function createFakeGuestSocket(): FakeGuestSocket {
  const messageHandlers: ((data: unknown) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  const sendObservers: ((msg: Record<string, unknown>) => void)[] = [];
  const writtenLines: string[] = [];
  let state = 1; // OPEN

  const ws: RpcWebSocket = {
    get readyState() {
      return state;
    },
    OPEN: 1,
    send(data: string) {
      writtenLines.push(data);
      const parsed = JSON.parse(data) as Record<string, unknown>;
      for (const cb of sendObservers) cb(parsed);
    },
    close() {
      if (state !== 1) return;
      state = 3;
      for (const cb of closeHandlers) cb();
    },
    on(event: "message" | "close", cb: ((data: unknown) => void) | (() => void)) {
      if (event === "message") messageHandlers.push(cb as (data: unknown) => void);
      else closeHandlers.push(cb as () => void);
    },
  };

  return {
    ws,
    writtenLines,
    sentMessages: () => writtenLines.map((l) => JSON.parse(l) as Record<string, unknown>),
    receive(msg: unknown) {
      const data = typeof msg === "string" ? msg : JSON.stringify(msg);
      for (const cb of messageHandlers) cb(data);
    },
    onSend(cb) {
      sendObservers.push(cb);
    },
    close: () => ws.close(),
  };
}

export function baseOpts(overrides?: Partial<AgentSpawnOptions>): AgentSpawnOptions {
  return {
    slug: "test-agent",
    workerCode: 'export default { name: "test" };',
    env: { FOO: "bar" },
    harnessPath: "/tmp/harness.mjs",
    ...overrides,
  };
}
