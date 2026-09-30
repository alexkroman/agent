// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /inbox` — the idle socket a device holds open so a run can reach it after
 * the voice session that started the run has closed.
 *
 * The server half of `stepNotifyClient` (`@alexkroman1/aai/step`, whose module
 * doc carries the wire format and why the RUN, not this module, is the outbox).
 * This holds the sockets open per client id, sends one notice at a time to each
 * client, and settles every send with `"acked"` or the reason it was not taken.
 * Nothing is queued here and nothing survives a restart: a notice that was not
 * taken is the step's to send again, and the step's journal is what outlives the
 * process.
 *
 * Built once per `AgentServer` by `installWorkflowSupport`, which publishes its
 * `notify` into the step slot — so it is rebuilt on every `aai dev` save, like the
 * sessions, and a device's socket is dropped with the old server. The device
 * reconnects; a notice in flight at that moment settles `"disconnected"` and is
 * retried.
 *
 * ## Several HOLDERS per client
 *
 * A client id is a conversation, and more than one thing can be in it: the
 * speaker on the counter and a browser "joined" to the same id both want the
 * reminder. So a socket names itself with `?holder=<id>` (the client-id rule),
 * and the inbox keeps one socket per (client, holder):
 *
 * - the SAME pair again REPLACES — a reconnect, whose old socket is usually
 *   half-dead (the device lost Wi-Fi and never sent a close);
 * - different holders COEXIST;
 * - no `?holder=` is the default holder, so a firmware that predates holders
 *   keeps its replace-on-reconnect behaviour exactly.
 *
 * A notice goes to EVERY open holder of the client, and settles once every
 * holder has answered (or timed out, or closed), as the step would want it read:
 * `"busy"` if ANY holder answered busy — so the step's retry brings it back, and
 * the holders that already played it drop the repeat by its id and ack it, which
 * is the protocol's redelivery rule — else `"acked"` if any holder acked; else
 * `"no-ack"` if any stayed silent, and `"disconnected"` if every socket closed.
 *
 * Settling on the FIRST ack instead lost the notice for a holder that was busy:
 * a page linked to a speaker, mid-conversation when a call's result came in,
 * answered busy, the idle speaker acked, and the page was never offered it again. The per-client send queue is
 * unchanged — one notice in flight per CLIENT, across all its holders — so two
 * runs due at once still reach a device one after the other.
 *
 * ## The live conversation, for a holder that asks (`?events=1`)
 *
 * A browser twin wants to SEE the speaker's conversation as it happens. A holder
 * that opens with `?events=1` is also sent `client-event-feed.ts`'s frames —
 * `{ type: "session_event", sessionId, event }` for the committed transcripts,
 * `tool.called`, the reply boundaries and the handshake, and
 * `{ type: "session_ended", sessionId }` — for every session bound to its
 * client. Never tool results and never audio: a device's socket is small. A
 * holder without the flag (the firmware) is sent nothing new.
 *
 * Event frames are FIRE-AND-FORGET and cannot get in a notice's way: they are
 * not queued, not acked, and a frame for a holder whose socket already has more
 * than {@link INBOX_EVENT_BUFFER_LIMIT_BYTES} unsent is DROPPED rather than
 * buffered behind the notice audio. A notice's header and its binary frames are
 * written in one synchronous pass, so no event frame can land between them.
 *
 * @internal
 */

import {
  CLIENT_ID_RE,
  type ClientNotifier,
  publishClientNotifier,
} from "@alexkroman1/aai/host-internal";
import { createOwnedMap, requestQuery } from "@alexkroman1/aai/internal";
import { createKeyedLock, omitUndefined, withLock } from "@alexkroman1/aai/utils";
import type { RawData, WebSocket } from "ws";
import { type ClientEventFrame, publishClientEventFeed } from "./client-event-feed.ts";
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

/**
 * How much unsent data a holder's socket may already carry before an EVENT
 * frame for it is dropped. A notice's audio is the only thing that fills a
 * socket this far, and a caption behind it is worth less than the notice.
 */
export const INBOX_EVENT_BUFFER_LIMIT_BYTES = 64 * 1024;

/** What a device may send: an ack or a busy, nothing large. */
const MAX_CLIENT_FRAME_BYTES = 1024;

/** The holder a socket that names none is — not a valid `?holder=`, so no socket can spell it. */
const DEFAULT_HOLDER = "";

type Outcome = Awaited<ReturnType<ClientNotifier>>;

type Pending = { id: string; settle: (outcome: Outcome) => void };

type Holder = {
  clientId: string;
  socket: WebSocket;
  alive: boolean;
  /** Whether it opened with `?events=1`. */
  events: boolean;
  pending?: Pending | undefined;
};

/** @internal */
export type ClientInbox = {
  /** Adopt an upgraded `/inbox` socket. Closes it when the URL names no valid client or holder. */
  attach(socket: WebSocket, rawUrl: string | undefined): void;
  notify: ClientNotifier;
  /** Client ids with at least one open socket, each once. */
  connected(): string[];
  /** Hand one conversation frame to every `?events=1` holder of `clientId`. */
  feed(clientId: string, frame: ClientEventFrame): void;
  close(): void;
};

/** The one map key a (client, holder) pair has. NUL cannot occur in either half. */
const holderKey = (clientId: string, holderId: string): string => `${clientId}\u0000${holderId}`;

/** How a notice settles once every holder has answered — see the module doc. */
function settled(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.includes("busy")) return "busy";
  if (outcomes.includes("acked")) return "acked";
  return outcomes.includes("no-ack") ? "no-ack" : "disconnected";
}

/** @internal */
export function createClientInbox(options: { logger: Logger; pingMs?: number }): ClientInbox {
  const { logger } = options;
  const holders = createOwnedMap<string, Holder>();
  /** The same holders indexed by client, so a send touches only that client's. */
  const byClient = new Map<string, Set<Holder>>();
  /** Each client's send chain: one notice in flight per client, across its holders. */
  const queues = createKeyedLock();

  const pinger = setInterval(() => {
    for (const holder of holders.values()) {
      if (!holder.alive) {
        holder.socket.terminate();
        continue;
      }
      holder.alive = false;
      holder.socket.ping();
    }
  }, options.pingMs ?? INBOX_PING_MS);
  pinger.unref?.();

  /** The open holders of `clientId`. */
  function openHolders(clientId: string): Holder[] {
    const own = byClient.get(clientId);
    if (!own) return [];
    return [...own].filter((holder) => holder.socket.readyState === holder.socket.OPEN);
  }

  function onMessage(holder: Holder, data: RawData): void {
    let msg: { type?: unknown; id?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const pending = holder.pending;
    if (!pending || msg.id !== pending.id) return; // a late answer to a settled send
    if (msg.type === "ack") pending.settle("acked");
    else if (msg.type === "busy") pending.settle("busy");
  }

  function attach(socket: WebSocket, rawUrl: string | undefined): void {
    const query = requestQuery(rawUrl ?? "");
    const clientId = query.get("client") ?? "";
    if (!CLIENT_ID_RE.test(clientId)) {
      socket.close(1008, "?client= must name the device (letters, digits, - and _)");
      return;
    }
    const holderId = query.get("holder") ?? DEFAULT_HOLDER;
    if (holderId !== DEFAULT_HOLDER && !CLIENT_ID_RE.test(holderId)) {
      socket.close(1008, "?holder= must be 1-64 letters, digits, - and _");
      return;
    }
    const key = holderKey(clientId, holderId);
    // The SAME holder again REPLACES: the old socket is usually half-dead, and its
    // in-flight send settles below. Another holder of the client is left alone.
    holders.get(key)?.socket.terminate();
    const holder: Holder = { clientId, socket, alive: true, events: query.get("events") === "1" };
    // The claim's own release, so this socket's close can never evict a successor.
    const release = holders.claim(key, holder);
    const own = byClient.get(clientId) ?? new Set<Holder>();
    byClient.set(clientId, own.add(holder));
    const label = holderId === DEFAULT_HOLDER ? clientId : `${clientId}/${holderId}`;
    logger.info(`inbox: ${label} connected${holder.events ? " (events)" : ""}`);
    socket.on("pong", () => {
      holder.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      // Checked per frame: `maxPayload` is the SHARED server's, sized for audio.
      if (!isBinary && byteLength(data) <= MAX_CLIENT_FRAME_BYTES) onMessage(holder, data);
    });
    socket.on("close", () => {
      holder.pending?.settle("disconnected");
      release();
      own.delete(holder);
      if (own.size === 0 && byClient.get(clientId) === own) byClient.delete(clientId);
      logger.info(`inbox: ${label} disconnected`);
    });
    socket.on("error", () => socket.terminate());
  }

  /**
   * Send `notice` to one holder and settle when it answers, stays silent past
   * `ackTimeoutMs`, or closes. `withdraw` settles it early and quietly, for a
   * notice another holder already took.
   */
  function offer(
    holder: Holder,
    notice: Parameters<ClientNotifier>[1],
    ackTimeoutMs: number,
  ): { outcome: Promise<Outcome>; withdraw: () => void } {
    let settle: (outcome: Outcome) => void = () => undefined;
    const outcome = new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => settle("no-ack"), ackTimeoutMs);
      settle = (value) => {
        clearTimeout(timer);
        if (holder.pending === pending) holder.pending = undefined;
        resolve(value);
      };
    });
    const pending: Pending = { id: notice.id, settle };
    holder.pending = pending;
    const audio = notice.audio ?? new Uint8Array(0);
    const header = {
      type: "notice",
      id: notice.id,
      event: notice.event,
      ...omitUndefined({ data: notice.data }),
      bytes: audio.length,
    };
    holder.socket.send(JSON.stringify(header));
    for (let at = 0; at < audio.length; at += INBOX_FRAME_BYTES) {
      holder.socket.send(audio.subarray(at, at + INBOX_FRAME_BYTES));
    }
    return { outcome, withdraw: () => settle("disconnected") };
  }

  /** One notice to every open holder of the client, settled as the module doc says. */
  function deliver(
    targets: readonly Holder[],
    notice: Parameters<ClientNotifier>[1],
    ackTimeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Outcome> {
    return new Promise<Outcome>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const offers = targets.map((holder) => offer(holder, notice, ackTimeoutMs));
      const outcomes: Outcome[] = [];
      let done = false;
      const onAbort = () => finish(() => reject(signal?.reason));
      function finish(settle: () => void): void {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        // Only an abort ends it with holders still unanswered: they stop waiting.
        for (const { withdraw } of offers) withdraw();
        settle();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      for (const { outcome } of offers) {
        void outcome.then((value) => {
          outcomes.push(value);
          if (outcomes.length === offers.length) finish(() => resolve(settled(outcomes)));
        });
      }
    });
  }

  const notify: ClientNotifier = (clientId, notice, { ackTimeoutMs, signal }) => {
    if (openHolders(clientId).length === 0) return Promise.resolve("offline");
    // Chained per CLIENT, so two runs due at once reach it one after the other.
    // The holders are read when the turn COMES, so one replaced or gone mid-chain
    // is answered from what is open then.
    return withLock(queues, clientId, async () => {
      const targets = openHolders(clientId);
      return targets.length === 0
        ? "offline"
        : await deliver(targets, notice, ackTimeoutMs, signal);
    });
  };

  function feed(clientId: string, frame: ClientEventFrame): void {
    let json: string | undefined;
    for (const holder of openHolders(clientId)) {
      if (!holder.events || holder.socket.bufferedAmount > INBOX_EVENT_BUFFER_LIMIT_BYTES) continue;
      json ??= JSON.stringify(frame);
      holder.socket.send(json);
    }
  }

  return {
    attach,
    notify,
    connected: () => [...byClient.keys()],
    feed,
    close() {
      clearInterval(pinger);
      for (const holder of holders.values()) holder.socket.terminate();
      holders.clear();
      byClient.clear();
    },
  };
}

/**
 * Build the inbox for one server and publish it as the step slot and the
 * conversation feed.
 *
 * `close` leaves both slots alone. `aai dev` builds the next server BEFORE
 * closing the last, so unpublishing on close would take the new server's inbox
 * away; a closed inbox left in a slot just answers `"offline"` and feeds nobody,
 * which is true.
 *
 * @internal
 */
export function installClientInbox(logger: Logger): ClientInbox {
  const inbox = createClientInbox({ logger });
  publishClientNotifier(inbox.notify);
  publishClientEventFeed(inbox.feed);
  return inbox;
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}
