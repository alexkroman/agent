// Copyright 2026 the AAI authors. MIT license.
/**
 * The four frames a guest→platform socket carries, declared once and parsed on
 * both ends.
 *
 * The wire is deliberately boring: a frame is one JSON object in one text frame,
 * and a REQUEST frame carries the same three things a `POST` carried — which
 * route, which trace, and an already-encoded body string. Nothing here re-encodes
 * a caller's payload, and nothing here knows what any route means. That is what
 * lets `platform-socket-handler.ts` turn a frame back into a `Request` and run it
 * through the very same Hono app the HTTP route uses, rather than growing a
 * second dispatch with a second set of statuses.
 *
 * ## Why not JSON-RPC, which this repo already speaks
 *
 * `aai-server/rpc-transport.ts` frames JSON-RPC 2.0 over the host→guest control
 * socket, and reaching for it here was the first thing tried. It is the wrong
 * envelope for this direction: JSON-RPC's reply is `result` XOR `error`, where
 * every one of these five routes answers an HTTP STATUS that the guest-side
 * clients already read — a 409 is `claim` refusing an id, a 404 is a run this
 * agent does not own, a 501 is a deployment without the feature, and
 * `RETRYABLE_STATUS` decides whether a step comes back. Mapping that onto
 * `error.code` and back would be a lossy translation in the middle of the one
 * path where the status IS the contract (`platform-rpc.ts`'s `statusError`).
 *
 * So the reply frame carries a status and a body, and the transport stays a
 * transport.
 *
 * ## Every frame carries an id, the heartbeat included
 *
 * A `ping` is correlated exactly like a request because the guest reads its
 * `pong` as a liveness ANSWER rather than as traffic: an unanswered ping is what
 * takes down a half-open socket, and a pong that cannot be matched to the ping
 * that is outstanding would let a stale one keep a dead socket alive.
 *
 * WebSocket's own protocol-level ping/pong would do this too, and is not used:
 * it proves the PROXY is alive, not the platform's Node process behind it, and
 * this socket crosses Modal's proxy. An application ping is answered by the same
 * dispatch loop that answers requests, so a wedged loop fails the heartbeat.
 *
 * @module platform-socket-frames
 */

import { z } from "zod";

/** One call, on its way to the platform. */
export const PlatformRequestFrameSchema = z.object({
  t: z.literal("req"),
  id: z.number().int().nonnegative(),
  /** One of `PLATFORM_ROUTES` — validated as a member by the reader, not here. */
  route: z.string().min(1),
  /** The W3C trace context this call was minted with, absent for none. */
  traceparent: z.string().optional(),
  /** The already-encoded request body — JSON for four routes, typed JSON for the journal. */
  body: z.string(),
});

/** One answer, on its way back. */
export const PlatformReplyFrameSchema = z.object({
  t: z.literal("res"),
  id: z.number().int().nonnegative(),
  /** The HTTP status the same route would have answered. */
  status: z.number().int(),
  /** The reply body, verbatim. */
  body: z.string(),
});

/** The guest asking whether the platform's dispatch loop is still answering. */
export const PlatformPingFrameSchema = z.object({
  t: z.literal("ping"),
  id: z.number().int().nonnegative(),
});

/** The platform saying it is. */
export const PlatformPongFrameSchema = z.object({
  t: z.literal("pong"),
  id: z.number().int().nonnegative(),
});

/** What the PLATFORM may receive. */
export const PlatformInboundFrameSchema = z.union([
  PlatformRequestFrameSchema,
  PlatformPingFrameSchema,
]);

/** What the GUEST may receive. */
export const PlatformOutboundFrameSchema = z.union([
  PlatformReplyFrameSchema,
  PlatformPongFrameSchema,
]);

export type PlatformRequestFrame = z.infer<typeof PlatformRequestFrameSchema>;
export type PlatformReplyFrame = z.infer<typeof PlatformReplyFrameSchema>;
export type PlatformInboundFrame = z.infer<typeof PlatformInboundFrameSchema>;

/**
 * One frame off the wire, or `undefined` for anything that is not one.
 *
 * `undefined` rather than a throw, and the same on both ends: a frame this build
 * does not recognise is how a newer peer would add one, and closing the socket
 * over it would turn a forwards-compatible addition into an outage. Both readers
 * log and drop. What is NOT tolerated is a reply that cannot be matched to a
 * pending call — that one is dropped too, but it can only mean the two ends
 * disagree about ids, so it is logged as such.
 *
 * @internal
 */
export function parsePlatformFrame<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
