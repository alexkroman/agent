// Copyright 2026 the AAI authors. MIT license.
/**
 * Declining a session socket: the client is told why in ONE fatal
 * `error.reported` frame — the shape every client already handles — and the
 * socket is closed with a policy code. `rejectingRuntime` declines every one.
 */

import { describe, expect, test } from "vitest";
import { silentLogger } from "../_logger-test-utils.ts";
import { MockWebSocket } from "../_mock-ws.ts";
import { asSessionWebSocket } from "../session/index.ts";
import { declineSocket, rejectingRuntime } from "./session-decline.ts";

function openSocket(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

function closeCodes(ws: MockWebSocket): (number | undefined)[] {
  const codes: (number | undefined)[] = [];
  ws.addEventListener("close", (event) => codes.push(event.code));
  return codes;
}

describe("declineSocket", () => {
  test("sends one fatal protocol error naming the reason, then closes 1008", () => {
    const ws = openSocket();
    const codes = closeCodes(ws);
    declineSocket(ws, "unknown agent", silentLogger);
    expect(ws.sentJson()).toEqual([
      expect.objectContaining({
        type: "error.reported",
        code: "protocol",
        message: "unknown agent",
        fatal: true,
      }),
    ]);
    expect(codes).toEqual([1008]);
  });

  test("takes another close code, and closes even a socket it could not write to", () => {
    const ws = new MockWebSocket("ws://test");
    const codes = closeCodes(ws);
    declineSocket(ws, "x", silentLogger, 4000);
    expect(ws.sent).toEqual([]);
    expect(codes).toEqual([4000]);
  });

  test("a socket with no close method is still told why", () => {
    const sent: unknown[] = [];
    const ws = asSessionWebSocket({
      readyState: MockWebSocket.OPEN,
      send: (data) => {
        sent.push(data);
      },
    });
    expect(() => declineSocket(ws, "nope", silentLogger)).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe("rejectingRuntime", () => {
  test("declines every session it is asked to start, and shuts down cleanly", async () => {
    const runtime = rejectingRuntime("host mode only", silentLogger);
    const ws = openSocket();
    const codes = closeCodes(ws);
    runtime.startSession(ws);
    expect(ws.sentJson()[0]).toMatchObject({ type: "error.reported", message: "host mode only" });
    expect(codes).toEqual([1008]);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
