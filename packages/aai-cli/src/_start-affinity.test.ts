// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  affinityKey,
  clientKey,
  mintIdForSlot,
  sessionKey,
  slotOf,
  ticketSessionId,
} from "./_start-affinity.ts";

/** A ticket shaped like the runtime's: base64url(JSON payload).signature. */
const ticket = (payload: object) =>
  `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJl`;

describe("affinityKey", () => {
  test("the client id wins over everything a request names", () => {
    const key = affinityKey("/websocket?client=phone-1&sessionId=s-9", {
      "sec-websocket-protocol": `aai.auth.${ticket({ sid: "s-ticket" })}`,
    });
    expect(key).toBe(clientKey("phone-1"));
  });

  test("without a client, a ticket's sid beats ?sessionId= (the runtime's precedence)", () => {
    expect(
      affinityKey("/websocket?sessionId=s-url", {
        "sec-websocket-protocol": `other, aai.auth.${ticket({ sid: "s-ticket" })}`,
      }),
    ).toBe(sessionKey("s-ticket"));
    expect(affinityKey(`/websocket?token=${ticket({ sid: "s-q" })}`, {})).toBe(sessionKey("s-q"));
  });

  test("a resume by session id alone routes by the session", () => {
    expect(affinityKey("/websocket?sessionId=s-1", {})).toBe(sessionKey("s-1"));
  });

  test("nothing to route by, or blank values, is undefined", () => {
    expect(affinityKey("/workflows/runs", {})).toBeUndefined();
    expect(affinityKey("/websocket?client=%20&sessionId=", {})).toBeUndefined();
    expect(affinityKey(undefined, {})).toBeUndefined();
  });
});

describe("ticketSessionId", () => {
  test("reads sid from the payload without the secret", () => {
    expect(ticketSessionId(ticket({ v: 1, sub: "x", sid: "abc" }))).toBe("abc");
  });

  test.each(["", "not-base64!.sig", ticket({ sub: "x" }), ticket({ sid: 7 })])(
    "answers undefined for %j",
    (value) => {
      expect(ticketSessionId(value)).toBeUndefined();
    },
  );
});

describe("slotOf / mintIdForSlot", () => {
  test("a key always maps to the same slot, within range", () => {
    expect(slotOf("client:phone-1", 4)).toBe(slotOf("client:phone-1", 4));
    for (let i = 0; i < 200; i++) {
      const slot = slotOf(`client:${i}`, 7);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(7);
    }
  });

  test("keys spread across every slot", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(slotOf(clientKey(`c${i}`), 4));
    expect(seen).toEqual(new Set([0, 1, 2, 3]));
  });

  test("a minted id routes back to the slot that minted it", () => {
    for (let slot = 0; slot < 5; slot++) {
      const id = mintIdForSlot(slot, 5);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(slotOf(sessionKey(id), 5)).toBe(slot);
    }
  });
});
