// Copyright 2026 the AAI authors. MIT license.
/**
 * `createInbox()` — hold this client's `WS /inbox?client=` socket open, so a
 * workflow run can reach the page after the voice session that started it has
 * closed: a reminder coming due, a research job finishing.
 *
 * The framework-agnostic core `useInbox()` wraps; the receiving rules (acks,
 * repeats, busy, a notice cut short) are `inbox-protocol.ts`, and the server
 * half is `aai-runtime`'s `aai-runtime/src/inbox/inbox.ts`.
 *
 * - **Held from creation, reconnected until `close()`**, on a jittered backoff
 *   from 1 s doubling to 30 s (`jitteredBackoff`), reset by every open. The
 *   jitter matters here more than for most loops: an agent restart drops every
 *   open inbox at once, and every tab of every user comes back together.
 * - **Its own socket, not partysocket.** The session's reconnecting socket
 *   re-brokers and resumes; the inbox has nothing to resume — a notice in
 *   flight when the socket drops settles `"disconnected"` server-side and the
 *   step resends it — so a plain `WebSocket` and a timer are the whole job.
 * - **The client id is asked per ATTEMPT**, like the session's `?client=`, so a
 *   page that changes it (joining a speaker) is heard on the next reconnect. No
 *   valid id means no socket this attempt — the loop keeps asking on its
 *   backoff, so a getter that answers later is picked up.
 * - **`?holder=` names this TAB** (`session.identity.holderId()`), so the page
 *   coexists with the device and the other tabs holding the same client rather
 *   than replacing their sockets.
 * - **A gated server checks a ticket here exactly as on `/websocket`**, so the
 *   inbox presents one the same way (`token`, asked per attempt, carried by
 *   `session/ticket.ts`). `useInbox()` passes the session's
 *   (`session.identity.ticket()`). A token answered synchronously (or none)
 *   dials at once; a Promise dials when it settles.
 * - **The URL is the agent's base URL + `inbox`**, like the session's
 *   `websocket`. On the managed platform the route is DIRECT-DIAL (served on the
 *   sandbox URL, not proxied at `/:slug/inbox`), so today this reaches an agent
 *   under `aai dev`, `aai start` or a self-hosted server.
 *
 * @module
 */

import { CLIENT_ID_RE, jitteredBackoff } from "@alexkroman1/aai/internal";
import { buildAgentUrl } from "./client-config.ts";
import { resolveReported } from "./client-identity.ts";
import {
  type AssemblerOutput,
  createNoticeAssembler,
  type InboxEvent,
  type InboxNotice,
  parseInboxEvent,
} from "./inbox-protocol.ts";
import { resolveSessionToken, resolveSessionTokenSync, ticketCarriage } from "./session/index.ts";
import type { VoiceSessionOptions, WebSocketConstructor } from "./types.ts";

/** The first reconnect window; each failure doubles it. */
export const INBOX_RECONNECT_BASE_MS = 1000;
/** The largest reconnect window. */
export const INBOX_RECONNECT_MAX_MS = 30_000;

/**
 * Options for {@link createInbox}.
 *
 * @public
 */
export type CreateInboxOptions = {
  /** The agent's base URL — the socket is `<platformUrl>/inbox`. */
  platformUrl: string;
  /**
   * This client's id, as the session sends it: a string, or a getter asked on
   * every connection attempt. An answer that is not a valid client id (letters,
   * digits, `-`, `_`, at most 64) opens no socket that attempt.
   */
  client: string | (() => string | undefined);
  /**
   * This page's holder id among the client's holders — per TAB (see
   * `session.identity.holderId()`). Same rule as a client id.
   */
  holder: string;
  /**
   * Asked when a new notice arrives: `true` answers `busy` and the step sends it
   * again later. Default: never busy. Not asked for a repeat, which is acked.
   */
  busy?: (() => boolean) | undefined;
  /** A notice arrived whole — once per delivery id; a repeat is acked, not delivered. */
  onNotice?: ((notice: InboxNotice) => void) | undefined;
  /** A frame of the client's live conversation — only with `events`. */
  onEvent?: ((event: InboxEvent) => void) | undefined;
  /**
   * Ask for the client's live conversation (`?events=1`). Default: whether an
   * `onEvent` was given.
   */
  events?: boolean | undefined;
  /**
   * The session ticket to present, for a server that requires one — the same
   * option, with the same rules, as `VoiceSessionOptions.token`: a string, or a
   * getter asked on EVERY connection attempt (told `sessionId: undefined`; the
   * inbox resumes no session). A getter that throws or rejects presents none.
   * `useInbox()` fills it in from the session.
   */
  token?: VoiceSessionOptions["token"];
  /** WebSocket constructor override, for tests. Default: the page's `WebSocket`. */
  WebSocket?: WebSocketConstructor | undefined;
};

/**
 * A held inbox socket — see {@link createInbox}.
 *
 * @sealed Only `createInbox` produces one.
 *
 * @public
 */
export type Inbox = {
  /** Whether the socket is open now. */
  connected(): boolean;
  /** Called whenever `connected()` changes. Returns the unsubscribe. */
  subscribe(callback: () => void): () => void;
  /** Close the socket for good and stop reconnecting. */
  close(): void;
};

/**
 * Hold `WS /inbox?client=&holder=` open, reconnecting with backoff, and answer
 * every notice the way the protocol requires — `ack` once it has arrived whole,
 * `busy` when `busy()` says so, a repeat acked without being delivered twice.
 *
 * Most clients call `useInbox()`, which fills in the client, holder and base URL
 * from the session and plays each notice. This is the same thing for a page
 * with no React, or for an inbox held under a different client than the
 * session's.
 *
 * @example
 * ```ts
 * import { createInbox } from "@alexkroman1/aai-ui";
 *
 * const inbox = createInbox({
 *   platformUrl: "https://speaker.example/",
 *   client: "kitchen-speaker",
 *   holder: "kitchen-speaker-tab1",
 *   onNotice: (notice) => console.log(notice.event, notice.data),
 * });
 * // later
 * inbox.close();
 * ```
 *
 * @param options - Where to connect, as whom, and what to do with a notice.
 * @returns The {@link Inbox} handle.
 * @throws RangeError when `holder` is not a valid holder id.
 *
 * @public
 */
export function createInbox(options: CreateInboxOptions): Inbox {
  if (!CLIENT_ID_RE.test(options.holder)) {
    throw new RangeError(`createInbox: holder "${options.holder}" is not a valid id`);
  }
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const events = options.events ?? options.onEvent !== undefined;
  const subscribers = new Set<() => void>();
  let socket: InstanceType<WebSocketConstructor> | undefined;
  let open = false;
  let closed = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // ONE assembler for the inbox's life, not one per socket: the repeat it must
  // recognise is the redelivery after a LOST ACK, and the commonest way to lose
  // an ack is the socket dropping just after the notice played — a fresh memory
  // per socket would play that reminder twice. Only the half-received notice is
  // dropped with a socket (`reset()` on close): the server resends it from its
  // header, so no byte of the next socket belongs to it.
  const assembler = createNoticeAssembler(() => options.busy?.() ?? false);

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    for (const callback of subscribers) callback();
  }

  function scheduleRetry(): void {
    if (closed) return;
    failures++;
    retry = setTimeout(
      connect,
      jitteredBackoff(failures, {
        baseMs: INBOX_RECONNECT_BASE_MS,
        maxMs: INBOX_RECONNECT_MAX_MS,
      }),
    );
  }

  function url(client: string, queryToken: string | undefined): string {
    const target = buildAgentUrl(options.platformUrl, "inbox");
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("client", client);
    target.searchParams.set("holder", options.holder);
    if (events) target.searchParams.set("events", "1");
    if (queryToken !== undefined) target.searchParams.set("token", queryToken);
    return target.toString();
  }

  /**
   * This attempt's ticket, through the session's own resolvers
   * (`session/ticket.ts`): trimmed, and a getter that throws or rejects yields
   * none, with the session's warning. A value answered synchronously stays
   * synchronous, so it dials at once. Never throws.
   */
  function askToken(): string | undefined | Promise<string | undefined> {
    const { token } = options;
    const attempt = { sessionId: undefined };
    if (typeof token !== "function") return resolveSessionTokenSync(token, attempt);
    let answer: ReturnType<typeof token>;
    try {
      answer = token(attempt);
    } catch (err) {
      answer = Promise.reject(err);
    }
    return typeof answer === "string" || answer === undefined
      ? resolveSessionTokenSync(answer, attempt)
      : resolveSessionToken(() => answer, attempt);
  }

  function connect(): void {
    retry = undefined;
    if (closed) return;
    const client = resolveReported(options.client);
    if (!(client && CLIENT_ID_RE.test(client))) {
      scheduleRetry();
      return;
    }
    const token = askToken();
    if (typeof token === "string" || token === undefined) {
      dial(client, token);
      return;
    }
    void token.then((answer) => {
      if (!closed) dial(client, answer);
    });
  }

  function dial(client: string, token: string | undefined): void {
    const carriage = ticketCarriage(token);
    const target = url(client, carriage.queryToken);
    const ws = carriage.protocols ? new Socket(target, carriage.protocols) : new Socket(target);
    ws.binaryType = "arraybuffer";
    socket = ws;
    const reply = (out: AssemblerOutput | undefined) => {
      if (!out) return;
      if (out.notice) options.onNotice?.(out.notice);
      ws.send(JSON.stringify(out.reply));
    };
    ws.addEventListener("open", () => {
      failures = 0;
      setOpen(true);
    });
    ws.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data !== "string") {
        reply(assembler.bytes(new Uint8Array(e.data as ArrayBuffer)));
        return;
      }
      const live = events ? parseInboxEvent(e.data) : undefined;
      if (live) options.onEvent?.(live);
      else reply(assembler.text(e.data));
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = undefined;
      setOpen(false);
      assembler.reset();
      scheduleRetry();
    });
  }

  connect();

  return {
    connected: () => open,
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    close() {
      closed = true;
      clearTimeout(retry);
      const ws = socket;
      socket = undefined;
      ws?.close();
      setOpen(false);
    },
  };
}
