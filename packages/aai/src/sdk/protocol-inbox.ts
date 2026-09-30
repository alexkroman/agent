// Copyright 2026 the AAI authors. MIT license.
/**
 * The `WS /inbox` frame vocabulary: what the agent's server sends a client's
 * idle socket, and what the client answers.
 *
 * The inbox is the second socket on an agent's server — the one a device holds
 * open so a workflow step can reach it after the voice session is gone
 * (`stepNotifyClient`, `@alexkroman1/aai/step`, whose module doc says why the
 * RUN is the outbox). Its two ends ship on different schedules, exactly like
 * `/websocket`'s: `aai-runtime`'s `client-inbox.ts` sends these frames from
 * whatever SDK the agent was built with, and `aai-ui`'s `inbox-protocol.ts` (or
 * a firmware's `inbox.c`) reads them. So they are declared ONCE, here, and both
 * ends are typed against this declaration.
 *
 * Text frames only. A notice's audio follows its header as `bytes` bytes of
 * BINARY frames, which carry no JSON and so no schema.
 *
 * @module
 */

import { z } from "zod";

/**
 * Zod schema for {@link InboxServerFrame}.
 *
 * A reader parses LENIENTLY where the two ends may disagree on a detail that is
 * not this socket's: a `session_event`'s `event` is checked only for its
 * `type`, since the session event vocabulary grows on its own schedule, and a
 * notice's `data` is whatever the step sent.
 */
export const InboxServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    /**
     * One notice from a workflow step: `bytes` bytes of audio follow in binary
     * frames (at most 4 KiB each). `id` identifies the DELIVERY, so a repeat
     * carries the same one and the client drops it; `data` is present only when
     * the step sent some.
     */
    type: z.literal("notice"),
    id: z.string().min(1),
    event: z.string(),
    data: z.unknown().optional(),
    bytes: z.number().int().min(0),
  }),
  z.object({
    /**
     * One event of a session bound to the client, for a holder that opened with
     * `?events=1` — fire-and-forget, never answered.
     */
    type: z.literal("session_event"),
    sessionId: z.string(),
    event: z.object({ type: z.string() }).passthrough(),
  }),
  z.object({
    /** A session bound to the client stopped (its log is flushed). `?events=1` only. */
    type: z.literal("session_ended"),
    sessionId: z.string(),
  }),
]);

/**
 * One text frame the server sends on `WS /inbox`: a notice header, or — for a
 * holder that asked with `?events=1` — a frame of the client's live
 * conversation.
 */
export type InboxServerFrame = z.infer<typeof InboxServerFrameSchema>;

/** Zod schema for {@link InboxClientFrame}. */
export const InboxClientFrameSchema = z.discriminatedUnion("type", [
  /** Have it — also the answer to a REPEAT, which is never played twice. */
  z.object({ type: z.literal("ack"), id: z.string() }),
  /** Not now; the step's retry brings it back. */
  z.object({ type: z.literal("busy"), id: z.string() }),
]);

/**
 * One text frame a client sends on `WS /inbox`: its answer to the notice whose
 * `id` it names.
 */
export type InboxClientFrame = z.infer<typeof InboxClientFrameSchema>;
