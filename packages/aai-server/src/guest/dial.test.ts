// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest WebSocket dial against a real loopback server (moved from
 * `warm-harness.test.ts`, which re-exports `dialGuest`).
 */

import net, { type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { dialGuest } from "./dial.ts";

describe("dialGuest", () => {
  it("connects to a listening harness and presents the bearer token", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.once("connection", (_ws, req) => resolve(req.headers.authorization));
    });

    const ws = await dialGuest(`ws://127.0.0.1:${port}/ws`, "tok-123");
    try {
      await expect(authHeader).resolves.toBe("Bearer tok-123");
      expect(ws.readyState).toBe(ws.OPEN);
    } finally {
      ws.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });

  it("retries refused connections until the harness server comes up", async () => {
    // A plain TCP server HOLDS the port and hangs up on every connection, so
    // the dial fails its handshake the way a not-yet-listening harness makes
    // it fail — then the real server takes the port over. Two things this buys
    // over the reserve-close-sleep shape it replaces: the failed attempt is
    // COUNTED rather than assumed to have happened inside a 150ms wall-clock
    // wait, and the port is never unowned in between, so no other process on
    // the machine can win the re-bind and turn this into a flake.
    let refused = 0;
    const holder = net.createServer((socket) => {
      refused += 1;
      socket.destroy();
    });
    await new Promise((resolve) => holder.listen(0, "127.0.0.1", () => resolve(undefined)));
    const port = (holder.address() as AddressInfo).port;

    const pending = dialGuest(`ws://127.0.0.1:${port}/ws`, "tok");
    await vi.waitFor(() => expect(refused).toBeGreaterThan(0));
    await new Promise((resolve) => holder.close(resolve));

    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise((resolve) => wss.once("listening", resolve));

    const ws = await pending;
    try {
      expect(ws.readyState).toBe(ws.OPEN);
    } finally {
      ws.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});
