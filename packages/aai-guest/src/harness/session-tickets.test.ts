// Copyright 2026 the AAI authors. MIT license.
import { createSessionToken } from "@alexkroman1/aai-runtime/auth";
import {
  GUEST_HOST,
  mintPlatformSessionTicket,
  platformSessionSecret,
} from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";
import { guestTicketVerifier } from "./session-tickets.ts";

const BEARER = "this-sandbox-bearer";

describe("guestTicketVerifier", () => {
  test("accepts the broker's ticket for THIS sandbox, bound to its session", () => {
    const verify = guestTicketVerifier(GUEST_HOST, BEARER, {});
    const identity = verify(mintPlatformSessionTicket({ secret: platformSessionSecret(BEARER) }));
    expect(identity?.sessionId).toEqual(expect.any(String));
  });

  test("refuses a ticket minted for another sandbox", () => {
    const verify = guestTicketVerifier(GUEST_HOST, BEARER, {});
    expect(
      verify(mintPlatformSessionTicket({ secret: platformSessionSecret("another-sandbox") })),
    ).toBeUndefined();
  });

  test("refuses a ticket signed with the bearer itself — the key is derived, not the bearer", () => {
    const verify = guestTicketVerifier(GUEST_HOST, BEARER, {});
    expect(verify(createSessionToken({ secret: BEARER, sub: "x" }))).toBeUndefined();
  });

  test("accepts the author's own tickets when the agent env sets AAI_SESSION_SECRET", () => {
    const author = createSessionToken({ secret: "author-secret", sub: "user-1" });
    expect(guestTicketVerifier(GUEST_HOST, BEARER, {})(author)).toBeUndefined();
    expect(
      guestTicketVerifier(GUEST_HOST, BEARER, { AAI_SESSION_SECRET: "author-secret" })(author),
    ).toEqual({
      sub: "user-1",
    });
    // A blank author secret is unset, not a key anything could sign with.
    const blank = createSessionToken({ secret: "x", sub: "y" });
    expect(
      guestTicketVerifier(GUEST_HOST, BEARER, { AAI_SESSION_SECRET: "  " })(blank),
    ).toBeUndefined();
  });
});
