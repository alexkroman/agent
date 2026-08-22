// Copyright 2026 the AAI authors. MIT license.
/**
 * The session COMMAND vocabulary: what a client asks the server to do.
 *
 * The other half of the split described in `protocol-events.ts`. A command is a
 * REQUEST, in the imperative, and it is the one thing on this socket that is
 * deliberately NOT retained: replaying a request is not replaying a fact, and a
 * log that mixed the two would let a reader arriving late believe the session
 * had asked for something twice.
 *
 * Names stay as they were. The complaint the split answers is that commands and
 * events shared one namespace with one shape — which no longer holds — and
 * renaming these too would be churn on five literals no author ever writes:
 * the events are what the hook surface makes author-visible, and these are what
 * `aai-ui` sends.
 *
 * @module
 */

import { z } from "zod";
import { capToolResult } from "../internal.ts";
import { MAX_PLAYBACK_BUFFERED_MS } from "./constants.ts";

/** Helper: a command carrying nothing but its own name. */
const cmd = <T extends string>(t: T) => z.object({ type: z.literal(t) });

/** Zod schema for {@link SessionCommand}. */
export const SessionCommandSchema = z.discriminatedUnion("type", [
  cmd("audio_ready"),
  cmd("cancel"),
  cmd("reset"),
  z.object({
    /**
     * How much forwarded agent audio the client still holds UNPLAYED.
     *
     * The one closed-loop signal in the protocol. Without it the host models
     * playback open-loop — `pipeline-heard.ts` assumes every forwarded chunk
     * begins playing the instant it is sent, at exactly 1.0x, plus a fixed
     * grace — and nothing anywhere can detect a client that drains slower than
     * real time. Such a client accrues a backlog that grows across a reply and
     * is invisible to the host, which then believes the line is silent while
     * the caller is still listening.
     *
     * Five things ride that estimate, and all five fail the same way: the
     * outward `speech.started` gate (opens early, so a client that truncates
     * on that event throws away speech the caller had not heard), the heard
     * cursor (records unheard words as delivered, so the model never repeats
     * them), the barge-in floor, the false-interruption resume anchor, and the
     * silence nudger. Measured against a harness draining at **0.60-0.67x**:
     * the host declared playback finished while the client still held 3.8-7.3s
     * of the reply, and 39.5s of agent speech — 41% of all audio it lost — was
     * destroyed on edges the barge-in gates had explicitly ruled were not
     * interruptions.
     *
     * **Advisory and monotonic in one direction only.** The host clamps
     * UPWARD (`max(existing, now + bufferedMs)`), never down, so a client that
     * never sends this, sends it late, or under-reports degrades to exactly
     * the open-loop behaviour — there is no way for this frame to make the
     * host think less audio is outstanding than it already believes, and no
     * existing client regresses by not adopting it. Send it while audio is
     * queued (aai-ui sends one every `PLAYBACK_PROGRESS_INTERVAL_MS`); stop
     * when the buffer empties.
     *
     * **It is a command and stays out of the retained stream**, which is the
     * one membership decision here that was genuinely open: it is a control
     * frame by shape and per-FRAME by volume, arriving every few hundred ms for
     * the whole of every reply. Being client→server settles it — the log
     * records what the session did, and this is the client describing itself.
     */
    type: z.literal("playback_progress"),
    bufferedMs: z.number().min(0).max(MAX_PLAYBACK_BUFFERED_MS),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string().min(1),
    /**
     * Truncated rather than rejected. A `.max()` here made an oversized result
     * fail validation, and a failed client message is *dropped* — so the relay
     * call it was answering never settled and hung to
     * `DEFAULT_RELAY_TOOL_TIMEOUT_MS`, presenting as a stuck tool rather than as
     * data that didn't fit. The transform bounds host memory the same way while
     * letting the turn continue on the part that fits (marked `[truncated]`).
     */
    result: z.string().transform(capToolResult),
    error: z.string().optional(),
  }),
]);

/**
 * **Client→server** text messages (binary frames carry raw PCM16 audio).
 *
 * Note there is no `history` command any more. A reconnecting client used to
 * push its own `messages` back because the server kept no record; the server is
 * authoritative now and a resume reads the retained event stream by index. See
 * "One durable session event stream" in the SDK guide.
 */
export type SessionCommand = z.infer<typeof SessionCommandSchema>;

/** The set of recognised client→server command `type` values — pass to
 *  `lenientParse` so a known-but-invalid message warns instead of being
 *  silently dropped as an unknown forward-compat type. */
export const SESSION_COMMAND_TYPES: ReadonlySet<string> = new Set(
  SessionCommandSchema.options.map((option) => option.shape.type.value),
);
