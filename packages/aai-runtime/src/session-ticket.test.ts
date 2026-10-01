// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  mintPlatformSessionTicket,
  PLATFORM_TICKET_RESUME_GRACE_SECONDS,
  platformSessionSecret,
  verifySessionToken,
} from "./session-ticket.ts";

const BEARER = "per-sandbox-bearer";
const platformSecret = platformSessionSecret(BEARER);

describe("the managed platform's tickets", () => {
  test("the key is derived from the bearer, deterministically, and is not the bearer", () => {
    expect(platformSessionSecret(BEARER)).toBe(platformSecret);
    expect(platformSecret).not.toBe(BEARER);
    expect(platformSessionSecret("another-sandbox")).not.toBe(platformSecret);
  });

  test("presenting the old ticket re-mints for the SAME session, even long expired", async () => {
    const first = mintPlatformSessionTicket({ guestToken: BEARER, now: 0 });
    const sid = verifySessionToken(first, { secret: platformSecret, now: 0 })?.sessionId;
    expect(sid).toEqual(expect.any(String));
    const hoursLater = 6 * 60 * 60 * 1000;
    const again = mintPlatformSessionTicket({
      guestToken: BEARER,
      presented: first,
      now: hoursLater,
    });
    expect(verifySessionToken(again, { secret: platformSecret, now: hoursLater })?.sessionId).toBe(
      sid,
    );
  });

  test("past the grace window, or forged, or under another sandbox, the ticket proves nothing", () => {
    const first = mintPlatformSessionTicket({ guestToken: BEARER, now: 0 });
    const sidOf = (t: string, now: number) =>
      verifySessionToken(t, { secret: platformSecret, now })?.sessionId;
    const firstSid = sidOf(first, 0);
    const late = (PLATFORM_TICKET_RESUME_GRACE_SECONDS + 120) * 1000;
    expect(
      sidOf(mintPlatformSessionTicket({ guestToken: BEARER, presented: first, now: late }), late),
    ).not.toBe(firstSid);
    const foreign = mintPlatformSessionTicket({ guestToken: "other", now: 0 });
    const viaForeign = mintPlatformSessionTicket({
      guestToken: BEARER,
      presented: foreign,
      now: 0,
    });
    expect(sidOf(viaForeign, 0)).not.toBe(sidOf(foreign, 0));
    const forged = `${first.split(".")[0]}.AAAA`;
    expect(
      sidOf(mintPlatformSessionTicket({ guestToken: BEARER, presented: forged, now: 0 }), 0),
    ).not.toBe(firstSid);
  });

  test("a ticket from the previous deploy still proves its session", () => {
    const old = mintPlatformSessionTicket({ guestToken: "v1-bearer", now: 0 });
    const oldSid = verifySessionToken(old, {
      secret: platformSessionSecret("v1-bearer"),
      now: 0,
    })?.sessionId;
    const next = mintPlatformSessionTicket({
      guestToken: BEARER,
      previousGuestTokens: ["v1-bearer"],
      presented: old,
      now: 0,
    });
    expect(verifySessionToken(next, { secret: platformSecret, now: 0 })?.sessionId).toBe(oldSid);
  });
});
