// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /inbox` against a real loopback socket, for the inbox's two specs: the
 * wire and its outcomes (`client-inbox.test.ts`), and several holders plus the
 * live event feed (`client-inbox-holders.test.ts`).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { silentLogger } from "./_test-utils.ts";
import { type ClientInbox, createClientInbox } from "./client-inbox.ts";

/** One device (or browser) on the far end of the inbox. */
export type InboxDevice = {
  ws: WebSocket;
  /** Every text frame parsed, and binary frames as byte counts. */
  frames: (Record<string, unknown> | number)[];
  next(): Promise<Record<string, unknown> | number>;
};

/** What a spec registers to be torn down, newest first. */
export type InboxCleanups = (() => void | Promise<void>)[];

/** An inbox behind a real HTTP server on a free loopback port. */
export async function startInbox(
  cleanups: InboxCleanups,
  pingMs?: number,
): Promise<{ inbox: ClientInbox; url: string }> {
  const inbox = createClientInbox({ logger: silentLogger, ...omitUndefined({ pingMs }) });
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => inbox.attach(ws, req.url));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    () => wss.close(),
    () => inbox.close(),
  );
  return { inbox, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/inbox` };
}

/**
 * Connect as `clientId`, with any extra query (`holder=…&events=1`), and wait
 * until the inbox has adopted the socket.
 */
export async function connectDevice(
  cleanups: InboxCleanups,
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
  await new Promise((resolve) => ws.once("open", resolve));
  // Adopted a tick after `open`; waited for without an assertion, since this is a helper.
  await vi.waitFor(() => {
    if (!inbox.connected().includes(clientId)) throw new Error(`${clientId} not adopted yet`);
  });
  cleanups.push(() => ws.terminate());
  return {
    ws,
    frames,
    next: () => {
      const queued = frames.shift();
      return queued !== undefined ? Promise.resolve(queued) : new Promise((r) => waiters.push(r));
    },
  };
}

/** Answer a notice from the device side. */
export const answerNotice = (ws: WebSocket, type: string, id: string): void =>
  ws.send(JSON.stringify({ type, id }));
