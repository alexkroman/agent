// Copyright 2026 the AAI authors. MIT license.
/**
 * Regression test for the assemblyai@4.36.3 connect-timeout crash. On a
 * timed-out connect attempt the SDK discards the half-open socket by
 * stripping all listeners and closing it; ws then emits an async "WebSocket
 * was closed before the connection was established" error that, with no
 * listeners left, escapes as an uncaught exception and can kill the host
 * process. `suppressDiscardedSocketError` re-arms a listener so the error is
 * swallowed. Unlike assemblyai.test.ts this file does NOT mock the SDK: it
 * drives the real transcriber against a local TCP server that accepts
 * connections but never answers, so the socket is still CONNECTING when the
 * connect timeout fires — the exact state that triggers the crash.
 */

import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { AssemblyAI } from "assemblyai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { suppressDiscardedSocketError } from "./assemblyai.ts";

let server: Server;
let port: number;
const clientSockets = new Set<Socket>();

beforeEach(async () => {
  // Accepts TCP connections and goes silent: the TLS handshake never
  // completes, so the ws client stays CONNECTING until the SDK timeout.
  server = createServer((socket) => {
    clientSockets.add(socket);
    socket.on("close", () => clientSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of clientSockets) socket.destroy();
  clientSockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("assemblyAI STT — connect-timeout socket teardown", () => {
  test("a timed-out connect rejects without an uncaught ws abort error", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const transcriber = new AssemblyAI({ apiKey: "test-key" }).streaming.transcriber({
        sampleRate: 16_000,
        websocketBaseUrl: `wss://127.0.0.1:${port}`,
        connectTimeout: 50,
        maxConnectionRetries: 0,
      });
      suppressDiscardedSocketError(transcriber);

      await expect(transcriber.connect()).rejects.toThrow(/timed out/);

      // ws emits the abort error on a later tick than the rejection; give it
      // time to fire before asserting nothing escaped.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});
