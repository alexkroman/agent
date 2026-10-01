// Copyright 2026 the AAI authors. MIT license.
/**
 * `parsePlatformFrame` is the first thing either end of the guest↔platform
 * socket runs on bytes the other end sent. Its contract is "a frame or
 * `undefined`, never a throw" — a throw there closes the socket, which turns a
 * newer peer's unknown frame into an outage — so it is checked against any
 * text at all, not only against the frames this build writes.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  PlatformInboundFrameSchema,
  PlatformOutboundFrameSchema,
  parsePlatformFrame,
} from "./socket-frames.ts";

const id = fc.nat();

const requestFrame = fc.record(
  {
    t: fc.constant("req" as const),
    id,
    route: fc.string({ minLength: 1 }),
    traceparent: fc.string(),
    body: fc.string(),
  },
  { requiredKeys: ["t", "id", "route", "body"] },
);
const pingFrame = fc.record({ t: fc.constant("ping" as const), id });
const replyFrame = fc.record({
  t: fc.constant("res" as const),
  id,
  status: fc.integer({ min: 100, max: 599 }),
  body: fc.string(),
});
const pongFrame = fc.record({ t: fc.constant("pong" as const), id });

const inbound = fc.oneof(requestFrame, pingFrame);
const outbound = fc.oneof(replyFrame, pongFrame);

/** Text off a socket: noise, any JSON, or a real frame with one field replaced by noise. */
const wireText = fc.oneof(
  fc.string(),
  fc.json(),
  fc
    .tuple(fc.oneof(inbound, outbound), fc.string(), fc.jsonValue())
    .map(([frame, key, value]) => JSON.stringify({ ...frame, [key]: value })),
);

describe("parsePlatformFrame", () => {
  test("any text is a frame the schema accepts, or undefined — never a throw", () => {
    fc.assert(
      fc.property(wireText, (text) => {
        const toPlatform = parsePlatformFrame(PlatformInboundFrameSchema, text);
        if (toPlatform !== undefined) {
          expect(PlatformInboundFrameSchema.safeParse(toPlatform).success).toBe(true);
        }
        const toGuest = parsePlatformFrame(PlatformOutboundFrameSchema, text);
        if (toGuest !== undefined) {
          expect(PlatformOutboundFrameSchema.safeParse(toGuest).success).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("every frame this build writes reads back as itself on the other end", () => {
    fc.assert(
      fc.property(inbound, (frame) => {
        expect(parsePlatformFrame(PlatformInboundFrameSchema, JSON.stringify(frame))).toEqual(
          frame,
        );
      }),
    );
    fc.assert(
      fc.property(outbound, (frame) => {
        expect(parsePlatformFrame(PlatformOutboundFrameSchema, JSON.stringify(frame))).toEqual(
          frame,
        );
      }),
    );
  });

  test("a field a newer peer adds does not make its frame unreadable", () => {
    fc.assert(
      fc.property(
        inbound,
        fc.dictionary(
          fc.string().map((k) => `x_${k}`),
          fc.jsonValue(),
        ),
        (frame, extra) => {
          const read = parsePlatformFrame(
            PlatformInboundFrameSchema,
            JSON.stringify({ ...extra, ...frame }),
          );
          expect(read).toEqual(frame);
        },
      ),
    );
  });

  test("the two directions never read each other's frames", () => {
    // A reply echoed back at the platform must not be dispatched as a request,
    // nor a request reflected at the guest settle a pending call.
    fc.assert(
      fc.property(inbound, outbound, (toPlatform, toGuest) => {
        expect(
          parsePlatformFrame(PlatformOutboundFrameSchema, JSON.stringify(toPlatform)),
        ).toBeUndefined();
        expect(
          parsePlatformFrame(PlatformInboundFrameSchema, JSON.stringify(toGuest)),
        ).toBeUndefined();
      }),
    );
  });
});
