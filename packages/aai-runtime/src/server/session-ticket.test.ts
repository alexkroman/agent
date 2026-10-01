// Copyright 2026 the AAI authors. MIT license.
import { createHmac } from "node:crypto";

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  createSessionToken,
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
    const first = mintPlatformSessionTicket({ secret: platformSessionSecret(BEARER), now: 0 });
    const sid = verifySessionToken(first, { secret: platformSecret, now: 0 })?.sessionId;
    expect(sid).toEqual(expect.any(String));
    const hoursLater = 6 * 60 * 60 * 1000;
    const again = mintPlatformSessionTicket({
      secret: platformSessionSecret(BEARER),
      presented: first,
      now: hoursLater,
    });
    expect(verifySessionToken(again, { secret: platformSecret, now: hoursLater })?.sessionId).toBe(
      sid,
    );
  });

  test("past the grace window, or forged, or under another sandbox, the ticket proves nothing", () => {
    const first = mintPlatformSessionTicket({ secret: platformSessionSecret(BEARER), now: 0 });
    const sidOf = (t: string, now: number) =>
      verifySessionToken(t, { secret: platformSecret, now })?.sessionId;
    const firstSid = sidOf(first, 0);
    const late = (PLATFORM_TICKET_RESUME_GRACE_SECONDS + 120) * 1000;
    expect(
      sidOf(
        mintPlatformSessionTicket({
          secret: platformSessionSecret(BEARER),
          presented: first,
          now: late,
        }),
        late,
      ),
    ).not.toBe(firstSid);
    const foreign = mintPlatformSessionTicket({ secret: platformSessionSecret("other"), now: 0 });
    const viaForeign = mintPlatformSessionTicket({
      secret: platformSessionSecret(BEARER),
      presented: foreign,
      now: 0,
    });
    expect(sidOf(viaForeign, 0)).not.toBe(sidOf(foreign, 0));
    const forged = `${first.split(".")[0]}.AAAA`;
    expect(
      sidOf(
        mintPlatformSessionTicket({
          secret: platformSessionSecret(BEARER),
          presented: forged,
          now: 0,
        }),
        0,
      ),
    ).not.toBe(firstSid);
  });

  test("a ticket from the previous deploy still proves its session", () => {
    const old = mintPlatformSessionTicket({ secret: platformSessionSecret("v1-bearer"), now: 0 });
    const oldSid = verifySessionToken(old, {
      secret: platformSessionSecret("v1-bearer"),
      now: 0,
    })?.sessionId;
    const next = mintPlatformSessionTicket({
      secret: platformSessionSecret(BEARER),
      previousSecrets: () => [platformSessionSecret("v1-bearer")],
      presented: old,
      now: 0,
    });
    expect(verifySessionToken(next, { secret: platformSecret, now: 0 })?.sessionId).toBe(oldSid);
  });
});

// ─── Properties ─────────────────────────────────────────────────────────────
//
// A ticket arrives from a browser, so `verifySessionToken` reads attacker-chosen
// text. Its contract is one answer — `undefined` — for forged, tampered,
// expired and malformed alike, and never a throw.

const SECRET = "property-test-secret";
const NOW_MS = 1_800_000_000_000;

const identity = fc.record(
  {
    sub: fc.string({ minLength: 1 }),
    sessionId: fc.string(),
    claims: fc.dictionary(fc.string(), fc.jsonValue()),
  },
  { requiredKeys: ["sub"] },
);

/** What a verified ticket hands back: the identity, as JSON would carry it. */
function asCarried(input: object): unknown {
  return JSON.parse(JSON.stringify(input));
}

describe("session tickets, for any input", () => {
  test("a minted ticket verifies to exactly the identity it was minted for", () => {
    fc.assert(
      fc.property(identity, fc.integer({ min: 1, max: 86_400 }), (who, ttlSeconds) => {
        const token = createSessionToken({ ...who, secret: SECRET, ttlSeconds, now: NOW_MS });
        expect(verifySessionToken(token, { secret: SECRET, now: NOW_MS })).toEqual(asCarried(who));
      }),
    );
  });

  test("changing any one character of a ticket makes it prove nothing", () => {
    fc.assert(
      fc.property(
        identity,
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 1 }),
        (who, at, replacement) => {
          const token = createSessionToken({ ...who, secret: SECRET, now: NOW_MS });
          const i = at % token.length;
          // Appended to rather than filtered, so the shrinker keeps every draw.
          const swapped = token[i] === replacement ? `${replacement}x` : replacement;
          const tampered = token.slice(0, i) + swapped + token.slice(i + 1);
          expect(verifySessionToken(tampered, { secret: SECRET, now: NOW_MS })).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a ticket under any other secret, or past its expiry, proves nothing", () => {
    fc.assert(
      fc.property(
        identity,
        fc.string({ minLength: 1 }).filter((s) => s.trim() !== ""),
        fc.integer({ min: 1, max: 3600 }),
        fc.integer({ min: 0, max: 10 ** 7 }),
        (who, other, ttlSeconds, lateBy) => {
          const token = createSessionToken({ ...who, secret: SECRET, ttlSeconds, now: NOW_MS });
          if (other !== SECRET) {
            expect(verifySessionToken(token, { secret: other, now: NOW_MS })).toBeUndefined();
          }
          const expired = NOW_MS + (ttlSeconds + lateBy) * 1000;
          expect(verifySessionToken(token, { secret: SECRET, now: expired })).toBeUndefined();
        },
      ),
    );
  });

  test("garbage is undefined, never a throw", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ maxLength: 5000 })), (token) => {
        expect(verifySessionToken(token, { secret: SECRET, now: NOW_MS })).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });

  test("a SIGNED payload of the wrong shape is refused, never a throw", () => {
    // Signed with the real key, so each draw gets past the HMAC and reaches the
    // payload checks — unreachable for a forger, reachable for a minter bug.
    // Mostly-legal fields, each sometimes replaced by any JSON value, with the
    // clock fields near NOW so some draws verify rather than every one failing
    // the expiry check (checked by hand: 11-16 of 500, over 3 runs).
    const field = (good: fc.Arbitrary<unknown>) =>
      fc.oneof({ arbitrary: good, weight: 3 }, { arbitrary: fc.jsonValue(), weight: 1 });
    const nowSec = NOW_MS / 1000;
    const nearNow = fc.integer({ min: nowSec - 3600, max: nowSec + 3600 });
    const payload = fc.oneof(
      fc.json(),
      fc
        .record(
          {
            v: field(fc.constant(1)),
            sub: field(fc.string()),
            iat: field(nearNow),
            exp: field(nearNow),
            sid: field(fc.string()),
            claims: field(fc.dictionary(fc.string(), fc.jsonValue())),
          },
          { requiredKeys: ["v", "sub", "iat", "exp"] },
        )
        .map((p) => JSON.stringify(p)),
    );
    fc.assert(
      fc.property(payload, (json) => {
        const body = Buffer.from(json).toString("base64url");
        const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
        const read = verifySessionToken(`${body}.${sig}`, { secret: SECRET, now: NOW_MS });
        if (read === undefined) return;
        // Whatever verified must be what a minter could have written.
        const p = JSON.parse(json) as Record<string, unknown>;
        expect(p.v).toBe(1);
        expect(typeof read.sub === "string" && read.sub !== "").toBe(true);
        expect(read.sessionId === undefined || typeof read.sessionId === "string").toBe(true);
        expect(Number(p.exp)).toBeGreaterThan(NOW_MS / 1000);
      }),
      { numRuns: 500 },
    );
  });
});
