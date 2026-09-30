// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of the `WS /inbox` wire, without the socket: frames in, what
 * to play and what to answer out.
 *
 * The server half is `aai-runtime`'s `client-inbox.ts`, and the frames are
 * declared once, as `InboxServerFrame` / `InboxClientFrame` on
 * `@alexkroman1/aai/protocol`, which both ends are typed against: a notice
 * header followed by `bytes` of audio in binary frames, answered with an ack or
 * a busy. What this module adds are the
 * CLIENT's rules, which the wire cannot state and which a firmware client
 * (`inbox.c` on an ESP32 speaker) worked out first:
 *
 * - **A repeat is acked, never replayed.** Delivery is at-least-once — an ack
 *   lost on the way back is the same notice again, by id — so the last
 *   {@link RECENT_NOTICE_IDS} acked ids are remembered and a repeat of one is
 *   acked without being played.
 * - **A repeat is acked EVEN WHILE BUSY.** Busy means "try again later", and for
 *   a notice already played there is no later: answering busy would have the
 *   run resend it until its attempts run out. And since the server settles a
 *   notice as busy if ANY holder was busy, a busy repeat also re-offers it to
 *   every other holder of the client.
 * - **A header mid-notice cuts the last one short, UNACKED.** The server sends
 *   one notice per client at a time, so a new header means the old one's socket
 *   write was abandoned; it will be resent, and acking what arrived would lose
 *   the rest.
 * - **Audio past `bytes` is dropped; bytes with no header are dropped.** A
 *   header that is not one this can take is left UNANSWERED (the server's ack
 *   timeout settles it) — the same as the device, which cannot answer an id it
 *   could not parse.
 *
 * The live-conversation frames a holder asked for with `?events=1`
 * (`client-event-feed.ts` server-side) share the text channel and are told apart
 * by {@link parseInboxEvent}.
 */

import {
  type InboxClientFrame,
  type InboxServerFrame,
  InboxServerFrameSchema,
} from "@alexkroman1/aai/protocol";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";

/**
 * One notice from the agent — what a workflow step sent with
 * `stepNotifyClient`, e.g. a reminder coming due.
 *
 * @public
 */
export type InboxNotice = {
  /** Identifies the DELIVERY (usually the run id); a repeat carries the same one. */
  readonly id: string;
  /** What the notice is, as the step named it — `"reminder"`, say. */
  readonly event: string;
  /** The step's `data`, when it sent an object. */
  readonly data?: Readonly<Record<string, unknown>>;
  /**
   * The notice's audio as sent: `stepSpeak`'s PCM16LE mono, which `useInbox`'s
   * built-in playback plays at 16 kHz. Empty for a notice with no audio.
   */
  readonly pcm: Uint8Array;
};

/**
 * One frame of the client's live conversation, sent to a holder that asked
 * for events: every session bound to the client, this tab's own included —
 * filter on `sessionId` (`useSessionId()`) to show only the OTHER ones.
 *
 * @public
 */
export type InboxEvent =
  | {
      readonly type: "session_event";
      readonly sessionId: string;
      /** The session event as the session socket would carry it (`type`, then its fields). */
      readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
    }
  | { readonly type: "session_ended"; readonly sessionId: string };

/**
 * The largest notice taken: 60 s of 16 kHz PCM16, the firmware's
 * `PROTO_NOTICE_MAX_BYTES`. A header claiming more is refused rather than
 * buffered — a page holds the whole notice in memory before it plays.
 */
export const MAX_NOTICE_BYTES = 60 * 16_000 * 2;

/** How many acked ids are remembered to drop a repeat — the firmware's `RECENT_IDS`. */
export const RECENT_NOTICE_IDS = 8;

/** The wire's notice header, as the server sends it. */
type NoticeFrame = Extract<InboxServerFrame, { type: "notice" }>;

/**
 * A notice header this client can take: the wire's, minus its `type`, with
 * `data` kept only when it is an object.
 */
export type NoticeHeader = Omit<NoticeFrame, "type" | "data"> & { data?: Record<string, unknown> };

/** What the client answers — the wire's client→server frame. */
export type NoticeReply = InboxClientFrame;

/** What one frame produced: a notice to play (not for a repeat), and the reply. */
export type AssemblerOutput = { notice?: InboxNotice; reply: NoticeReply };

/** Parse a text frame as one of the wire's server frames, or undefined. */
function parseServerFrame(json: string): InboxServerFrame | undefined {
  const parsed = InboxServerFrameSchema.safeParse(safeJsonParse(json));
  return parsed.success ? parsed.data : undefined;
}

/**
 * A notice header this client can take, or undefined — for anything that is
 * not one, and for a header it must refuse (odd byte count: not PCM16; more
 * than {@link MAX_NOTICE_BYTES}).
 */
export function parseNoticeHeader(json: string): NoticeHeader | undefined {
  const frame = parseServerFrame(json);
  if (frame?.type !== "notice") return;
  const { id, event, data, bytes } = frame;
  if (bytes > MAX_NOTICE_BYTES || bytes % 2 !== 0) return;
  return isRecord(data) ? { id, event, bytes, data } : { id, event, bytes };
}

/**
 * A live-event frame, or undefined for anything else (a notice header, say).
 * The wire's live frames are returned as the published {@link InboxEvent}, so
 * that view cannot drift from what the server sends without this failing to
 * compile.
 */
export function parseInboxEvent(json: string): InboxEvent | undefined {
  const frame = parseServerFrame(json);
  return frame === undefined || frame.type === "notice" ? undefined : frame;
}

/** The notice being received: its header, the chunks so far, and whether it plays. */
type Pending = { header: NoticeHeader; chunks: Uint8Array[]; got: number; play: boolean };

/**
 * The receiving state machine of one socket — see the module doc for its four
 * rules. `busy()` is asked when a NEW notice's header arrives, never for a
 * repeat.
 */
export function createNoticeAssembler(busy: () => boolean) {
  const recent: string[] = [];
  let pending: Pending | undefined;

  function remember(id: string): void {
    if (recent.includes(id)) return;
    recent.push(id);
    if (recent.length > RECENT_NOTICE_IDS) recent.shift();
  }

  function finish(done: Pending): AssemblerOutput {
    pending = undefined;
    const { header, chunks, play } = done;
    remember(header.id);
    const reply: NoticeReply = { type: "ack", id: header.id };
    if (!play) return { reply };
    const pcm = new Uint8Array(header.bytes);
    let at = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, at);
      at += chunk.length;
    }
    const notice: InboxNotice = header.data
      ? { id: header.id, event: header.event, data: header.data, pcm }
      : { id: header.id, event: header.event, pcm };
    return { notice, reply };
  }

  return {
    /** A text frame that is not a live event. A header mid-notice drops the last one, unacked. */
    text(json: string): AssemblerOutput | undefined {
      const header = parseNoticeHeader(json);
      if (!header) return undefined;
      const repeat = recent.includes(header.id);
      if (!repeat && busy()) {
        pending = undefined;
        return { reply: { type: "busy", id: header.id } };
      }
      const next: Pending = { header, chunks: [], got: 0, play: !repeat };
      pending = next;
      return header.bytes === 0 ? finish(next) : undefined;
    },
    /**
     * Forget a notice half-received (its socket closed), keeping the repeat
     * memory — the redelivery after a lost ack comes on the NEXT socket.
     */
    reset(): void {
      pending = undefined;
    },
    /** A binary frame of the pending notice's audio. */
    bytes(chunk: Uint8Array): AssemblerOutput | undefined {
      const current = pending;
      if (!current) return undefined;
      const room = current.header.bytes - current.got;
      const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
      current.chunks.push(take);
      current.got += take.length;
      return current.got >= current.header.bytes ? finish(current) : undefined;
    },
  };
}
