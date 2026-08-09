// Copyright 2026 the AAI authors. MIT license.
// The rate-limit key (client-ip.ts). The whole file exists to read the
// X-Forwarded-For chain from the RIGHT end; reading the left one hands every
// attacker an unlimited supply of keys, which is what the limiters using it
// exist to deny.

import { describe, expect, test } from "vitest";
import { clientIp, UNKNOWN_CLIENT_IP } from "./client-ip.ts";

const withXff = (value?: string) =>
  new Request("http://platform.test/deploy", {
    headers: value === undefined ? {} : { "x-forwarded-for": value },
  });

describe("clientIp", () => {
  test("takes the LAST entry — the one our own proxy appended", () => {
    expect(clientIp(withXff("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(withXff("198.51.100.1, 203.0.113.7"))).toBe("203.0.113.7");
  });

  test("a client-supplied prefix cannot change the key", () => {
    // The attack: send your own X-Forwarded-For and get a fresh bucket per
    // request. Modal appends the real peer, so the real peer is on the right.
    const forged = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((claim) =>
      clientIp(withXff(`${claim}, 203.0.113.7`)),
    );
    expect(new Set(forged)).toEqual(new Set(["203.0.113.7"]));
  });

  test("no header at all is one shared bucket, which over-limits rather than opens", () => {
    expect(clientIp(withXff())).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(withXff(""))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(withXff("  ,  "))).toBe(UNKNOWN_CLIENT_IP);
  });

  test("extra trusted hops count further from the right", () => {
    const chain = "198.51.100.1, 203.0.113.7, 10.0.0.9";
    expect(clientIp(withXff(chain), 2)).toBe("203.0.113.7");
  });

  test("a chain shorter than the configured hops clamps instead of losing the key", () => {
    expect(clientIp(withXff("203.0.113.7"), 5)).toBe("203.0.113.7");
  });

  test("entries are trimmed and case-folded so one peer is one bucket", () => {
    expect(clientIp(withXff("  2001:DB8::1  "))).toBe("2001:db8::1");
  });
});
