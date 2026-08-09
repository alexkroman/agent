// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's two-key rate-limit gate (studio-route-limits.ts).
 *
 * The scope key alone was decorative against the traffic it exists to stop:
 * for a raw-key caller `studioScope` hashes the bearer THEY chose, so one
 * character's difference minted a fresh window. The IP key is the one that
 * does not move when the bearer does.
 */

import { createRateLimiter } from "aai-server/rate-limit";
import { describe, expect, test } from "vitest";
import { createRouteLimits } from "./studio-route-limits.ts";

const req = (ip?: string) =>
  new Request("http://studio.test/studio/projects", {
    headers: ip === undefined ? {} : { "x-forwarded-for": ip },
  });

/** Limiters small enough to exercise both axes independently. */
const limiters = (scopeLimit: number, ipLimit: number) => ({
  chat: createRateLimiter({ limit: scopeLimit, windowMs: 60_000 }),
  projectCreate: createRateLimiter({ limit: scopeLimit, windowMs: 60_000 }),
  chatIp: createRateLimiter({ limit: ipLimit, windowMs: 60_000 }),
  projectCreateIp: createRateLimiter({ limit: ipLimit, windowMs: 60_000 }),
});

describe("createRouteLimits", () => {
  test("allows traffic inside both limits", async () => {
    const limits = createRouteLimits(limiters(5, 5));
    expect(await limits.chat("scope-a", req("203.0.113.1"))).toBeNull();
  });

  test("the scope limit still refuses, with Retry-After", async () => {
    const limits = createRouteLimits(limiters(1, 100));
    expect(await limits.projectCreate("scope-a", req("203.0.113.1"))).toBeNull();
    const refused = await limits.projectCreate("scope-a", req("203.0.113.1"));
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("rotating the scope no longer buys a fresh window — the IP limit holds", async () => {
    // The exact bypass: a new bearer per request is a new scope per request.
    const limits = createRouteLimits(limiters(100, 2));
    const ip = req("203.0.113.9");
    expect(await limits.chat("scope-1", ip)).toBeNull();
    expect(await limits.chat("scope-2", ip)).toBeNull();
    const refused = await limits.chat("scope-3", ip);
    expect(refused?.status).toBe(429);
  });

  test("a different IP is unaffected by another's exhausted window", async () => {
    const limits = createRouteLimits(limiters(100, 1));
    expect(await limits.chat("s", req("203.0.113.1"))).toBeNull();
    expect((await limits.chat("s", req("203.0.113.1")))?.status).toBe(429);
    expect(await limits.chat("s", req("203.0.113.2"))).toBeNull();
  });

  test("the two routes meter independently", async () => {
    const limits = createRouteLimits(limiters(1, 100));
    expect(await limits.chat("s", req("203.0.113.1"))).toBeNull();
    // projectCreate has its own window; chat's exhaustion must not spend it.
    expect(await limits.projectCreate("s", req("203.0.113.1"))).toBeNull();
  });

  test("defaults apply when nothing is injected", async () => {
    const limits = createRouteLimits();
    expect(await limits.chat("s", req("203.0.113.1"))).toBeNull();
  });
});
