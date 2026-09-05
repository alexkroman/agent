// Copyright 2026 the AAI authors. MIT license.
// The studio's rate-limit POLICY, and the one thing about it that cannot be
// checked by reading a diff: that every window this module declares actually
// reaches a Postgres-backed limiter in production.
//
// A window declared here but not answered by `createPgStudioRateLimiters`
// falls through to `createRateLimiter`'s in-memory arm at the composition
// root, where the limit multiplies by the replica count and resets on every
// deploy. Nothing goes red when that happens — every route spec injects a
// limiter and so never exercises the default — which is exactly how the agent
// surface's workflow limiters ran at 3x their written value for months.

import { readFileSync } from "node:fs";
import { CLIENT_IP_RATE_LIMIT_WINDOW_MS } from "aai-server/http";
import { describe, expect, test } from "vitest";
import {
  createPgStudioRateLimiters,
  GITHUB_SYNC_IP_RATE_LIMIT,
  GITHUB_SYNC_RATE_LIMIT,
} from "./studio-rate-limit.ts";

/** A `SqlExec` that records nothing — the factory only closes over it. */
const noSql = () => Promise.resolve([]);

/** Every `*_RATE_LIMIT` window this module exports, read from its source. */
function declaredWindows(): string[] {
  const source = readFileSync(new URL("./studio-rate-limit.ts", import.meta.url), "utf8");
  return [...source.matchAll(/^export const (\w+_RATE_LIMIT) = /gm)].map((match) => match[1] ?? "");
}

describe("createPgStudioRateLimiters", () => {
  test("answers EVERY window this module declares", () => {
    const windows = declaredWindows();
    // A scan whose whole output is a list prints the same pass when it matches
    // nothing; eight is what the surface has today and the floor under a rename.
    expect(windows.length).toBeGreaterThanOrEqual(8);
    // One limiter per window: the factory's key count is what the composition
    // root spreads, so a window with no key is a window with no Postgres arm.
    expect(Object.keys(createPgStudioRateLimiters(noSql))).toHaveLength(windows.length);
  });

  test("every limiter it answers is a distinct object", () => {
    // Each window is its own row namespace (`name` in the limiter options), so
    // two keys sharing one limiter would silently pool two budgets — the kind
    // of copy-paste slip a key-count assertion alone cannot see.
    const limiters = Object.values(createPgStudioRateLimiters(noSql));
    expect(new Set(limiters).size).toBe(limiters.length);
  });
});

describe("the GitHub sync windows", () => {
  test("the scope window is the tightest of the studio's four", () => {
    // It is the only one whose cost lands on a THIRD party that meters us as
    // one App across every tenant, so it protects the App's standing with
    // GitHub as much as it protects this service.
    expect(GITHUB_SYNC_RATE_LIMIT).toEqual({ limit: 30, windowMs: 5 * 60_000 });
  });

  test("the per-IP companion shares the platform's IP window", () => {
    // Every per-IP limit in the studio uses one window length, so a caller
    // rotating bearers meets the same clock on whichever route they pick.
    expect(GITHUB_SYNC_IP_RATE_LIMIT.windowMs).toBe(CLIENT_IP_RATE_LIMIT_WINDOW_MS);
    expect(GITHUB_SYNC_IP_RATE_LIMIT.limit).toBeGreaterThan(GITHUB_SYNC_RATE_LIMIT.limit);
  });
});
