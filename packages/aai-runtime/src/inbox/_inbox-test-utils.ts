// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /inbox` against a real loopback socket, for the inbox's two specs: the
 * wire and its outcomes (`inbox.test.ts`), and several holders plus the
 * live event feed (`holders.test.ts`).
 */

import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { onTestFinished, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { silentLogger } from "../_logger-test-utils.ts";
import { type ClientInbox, createClientInbox } from "./inbox.ts";

/** One device (or browser) on the far end of the inbox. */
export type InboxDevice = {
  ws: WebSocket;
  /** Every text frame parsed, and binary frames as byte counts. */
  frames: (Record<string, unknown> | number)[];
  next(): Promise<Record<string, unknown> | number>;
};

/**
 * An inbox behind a real HTTP server on a free loopback port, torn down when the
 * calling test finishes (`onTestFinished` runs newest first, so devices close
 * before the inbox, and the inbox before its server).
 */
export async function startInbox(pingMs?: number): Promise<{ inbox: ClientInbox; url: string }> {
  const inbox = createClientInbox({ logger: silentLogger, ...omitUndefined({ pingMs }) });
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => inbox.attach(ws, req.url));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  onTestFinished(() => wss.close());
  onTestFinished(() => inbox.close());
  return { inbox, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/inbox` };
}

/**
 * Connect as `clientId`, with any extra query (`holder=…&events=1`), and wait
 * until the inbox has adopted the socket.
 */
export async function connectDevice(
  url: string,
  inbox: ClientInbox,
  clientId = "speaker",
  extra = "",
): Promise<InboxDevice> {
  const ws = new WebSocket(`${url}?client=${clientId}${extra ? `&${extra}` : ""}`);
  const frames: InboxDevice["frames"] = [];
  const waiters: ((f: InboxDevice["frames"][number]) => void)[] = [];
  ws.on("message", (data, isBinary) => {
    const frame = isBinary ? (data as Buffer).length : JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await once(ws, "open");
  // Adopted a tick after `open`; waited for without an assertion, since this is a helper.
  await vi.waitFor(() => {
    if (!inbox.connected().includes(clientId)) throw new Error(`${clientId} not adopted yet`);
  });
  onTestFinished(() => ws.terminate());
  return {
    ws,
    frames,
    next: () => {
      const queued = frames.shift();
      return queued !== undefined ? Promise.resolve(queued) : new Promise((r) => waiters.push(r));
    },
  };
}

/**
 * A ping round trip on the device's socket: every frame the inbox wrote before the
 * pong has arrived by the time this resolves, so "nothing more was sent" is checked
 * against the wire rather than against a guessed delay.
 */
export async function roundTrip(device: InboxDevice): Promise<void> {
  device.ws.ping();
  await once(device.ws, "pong");
}

/** Answer a notice from the device side. */
export const answerNotice = (ws: WebSocket, type: string, id: string): void =>
  ws.send(JSON.stringify({ type, id }));
