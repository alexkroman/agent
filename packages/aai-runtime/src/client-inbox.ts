// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /inbox` — the idle socket a device holds open so a run can reach it after
 * the voice session that started the run has closed.
 *
 * The server half of `stepNotifyClient` (`@alexkroman1/aai/step`, whose module
 * doc carries the wire format and why the RUN, not this module, is the outbox).
 * This holds one socket per client id, sends one notice at a time to each, and
 * settles every send with `"acked"` or the reason it was not taken. Nothing is
 * queued here and nothing survives a restart: a notice that was not taken is the
 * step's to send again, and the step's journal is what outlives the process.
 *
 * Built once per `AgentServer` by `installWorkflowSupport`, which publishes its
 * `notify` into the step slot — so it is rebuilt on every `aai dev` save, like the
 * sessions, and a device's socket is dropped with the old server. The device
 * reconnects; a notice in flight at that moment settles `"disconnected"` and is
 * retried.
 *
 * @internal
 */

import {
  CLIENT_ID_RE,
  type ClientNotifier,
  publishClientNotifier,
} from "@alexkroman1/aai/host-internal";
import { createOwnedMap, requestQuery } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { RawData, WebSocket } from "ws";
import type { Logger } from "./runtime-config.ts";

/** @internal */
export const CLIENT_INBOX_PATH = "/inbox";

/**
 * Largest binary frame a notice's bytes are split into. Small enough for a
 * microcontroller's websocket buffer to take a frame in one piece.
 */
export const INBOX_FRAME_BYTES = 4096;

/** How often each socket is pinged; one missed period drops it. */
export const INBOX_PING_MS = 20_000;

/** What a device may send: an ack or a busy, nothing large. */
const MAX_CLIENT_FRAME_BYTES = 1024;

type Outcome = Awaited<ReturnType<ClientNotifier>>;

type Pending = { id: string; settle: (outcome: Outcome) => void };

type Client = {
  socket: WebSocket;
  alive: boolean;
  pending?: Pending | undefined;
  /** The tail of this client's send chain: one notice in flight at a time. */
  queue: Promise<unknown>;
};

/** @internal */
export type ClientInbox = {
  /** Adopt an upgraded `/inbox` socket. Closes it when the URL names no valid client. */
  attach(socket: WebSocket, rawUrl: string | undefined): void;
  notify: ClientNotifier;
  /** Client ids with an open socket. */
  connected(): string[];
  close(): void;
};

/** @internal */
export function createClientInbox(options: { logger: Logger; pingMs?: number }): ClientInbox {
  const { logger } = options;
  const clients = createOwnedMap<string, Client>();

  const pinger = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, options.pingMs ?? INBOX_PING_MS);
  pinger.unref?.();

  function onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    let msg: { type?: unknown; id?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const pending = client.pending;
    if (!pending || msg.id !== pending.id) return; // a late answer to a settled send
    if (msg.type === "ack") pending.settle("acked");
    else if (msg.type === "busy") pending.settle("busy");
  }

  function attach(socket: WebSocket, rawUrl: string | undefined): void {
    const clientId = requestQuery(rawUrl ?? "").get("client") ?? "";
    if (!CLIENT_ID_RE.test(clientId)) {
      socket.close(1008, "?client= must name the device (letters, digits, - and _)");
      return;
    }
    // A reconnect REPLACES: the old socket is usually half-dead (the device lost
    // Wi-Fi and never sent a close), and its in-flight send settles below.
    clients.get(clientId)?.socket.terminate();
    const client: Client = { socket, alive: true, queue: Promise.resolve() };
    // The claim's own release, so this socket's close can never evict a successor.
    const release = clients.claim(clientId, client);
    logger.info(`inbox: ${clientId} connected`);
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      // Checked per frame: `maxPayload` is the SHARED server's, sized for audio.
      if (!isBinary && byteLength(data) <= MAX_CLIENT_FRAME_BYTES) onMessage(client, data, false);
    });
    socket.on("close", () => {
      client.pending?.settle("disconnected");
      release();
      logger.info(`inbox: ${clientId} disconnected`);
    });
    socket.on("error", () => socket.terminate());
  }

  function send(
    client: Client,
    notice: Parameters<ClientNotifier>[1],
    ackTimeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Outcome> {
    return new Promise<Outcome>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => finish(() => reject(signal?.reason));
      const timer = setTimeout(() => finish(() => resolve("no-ack")), ackTimeoutMs);
      function finish(done: () => void): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (client.pending === pending) client.pending = undefined;
        done();
      }
      const pending: Pending = {
        id: notice.id,
        settle: (outcome) => finish(() => resolve(outcome)),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      client.pending = pending;
      const audio = notice.audio ?? new Uint8Array(0);
      const header = {
        type: "notice",
        id: notice.id,
        event: notice.event,
        ...omitUndefined({ data: notice.data }),
        bytes: audio.length,
      };
      client.socket.send(JSON.stringify(header));
      for (let at = 0; at < audio.length; at += INBOX_FRAME_BYTES) {
        client.socket.send(audio.subarray(at, at + INBOX_FRAME_BYTES));
      }
    });
  }

  const notify: ClientNotifier = (clientId, notice, { ackTimeoutMs, signal }) => {
    const client = clients.get(clientId);
    if (!client) return Promise.resolve("offline");
    // Chained, so two runs due at once reach the device one after the other. A
    // socket replaced mid-chain answers the rest from the check below.
    const turn = client.queue.then(() =>
      clients.owns(clientId, client) && client.socket.readyState === client.socket.OPEN
        ? send(client, notice, ackTimeoutMs, signal)
        : ("offline" as const),
    );
    client.queue = turn.catch(() => undefined);
    return turn;
  };

  return {
    attach,
    notify,
    connected: () => [...clients.keys()],
    close() {
      clearInterval(pinger);
      for (const client of clients.values()) client.socket.terminate();
      clients.clear();
    },
  };
}

/**
 * Build the inbox for one server and publish it as the step slot.
 *
 * `close` leaves the slot alone. `aai dev` builds the next server BEFORE closing
 * the last, so unpublishing on close would take the new server's inbox away; a
 * closed inbox left in the slot just answers `"offline"`, which is true.
 *
 * @internal
 */
export function installClientInbox(logger: Logger): ClientInbox {
  const inbox = createClientInbox({ logger });
  publishClientNotifier(inbox.notify);
  return inbox;
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}
