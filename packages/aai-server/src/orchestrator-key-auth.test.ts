// Copyright 2026 the AAI authors. MIT license.
/**
 * The authentication boundary in front of ownership.
 *
 * `orchestrator-security.test.ts` covers cross-agent isolation — key A cannot
 * touch agent B — which is authorization and was always sound. These cover
 * the question that sat in front of it and had no answer: is the bearer a
 * credential AssemblyAI issued at all? Without that, `POST /deploy` claimed
 * an unclaimed slug for any string, so the isolation below it was isolation
 * between anonymous strangers.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import type { ApiKeyVerifier } from "./api-key-verify.ts";
import { createRateLimiter } from "./rate-limit.ts";
import {
  authFetch,
  authHeaders,
  createTestOrchestrator,
  deploy,
  deployBody,
} from "./test-utils.ts";

/** Accepts exactly the listed keys, rejects everything else. */
const verifierAccepting = (...valid: string[]): ApiKeyVerifier =>
  vi.fn(async (key: string) => valid.includes(key));

describe("raw API-key verification", () => {
  test("an unrecognized bearer cannot deploy", async () => {
    const keyVerifier = verifierAccepting("real-key");
    const { fetch, store } = await createTestOrchestrator({ keyVerifier });

    const res = await deploy(fetch, { key: "not-a-real-key", body: { slug: "squatted" } });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
    // The slug must be untouched — a rejected deploy that still claimed the
    // name would leave the squat in place with a 401 on top of it.
    expect(await store.getAgent("squatted")).toBeNull();
  });

  test("a recognized bearer deploys exactly as before", async () => {
    const keyVerifier = verifierAccepting("real-key");
    const { fetch, store } = await createTestOrchestrator({ keyVerifier });

    const res = await deploy(fetch, { key: "real-key", body: { slug: "legit" } });

    expect(res.status).toBe(200);
    expect(await store.getAgent("legit")).not.toBeNull();
  });

  test("an unreachable verifier is 503, never a pass", async () => {
    // Fail-open here would restore the whole hole for the duration of any
    // outage an attacker can provoke or wait out.
    const keyVerifier: ApiKeyVerifier = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const { fetch, store } = await createTestOrchestrator({ keyVerifier });

    const res = await deploy(fetch, { key: "anything", body: { slug: "outage" } });

    expect(res.status).toBe(503);
    expect(await store.getAgent("outage")).toBeNull();
  });

  test("owner-scoped routes verify too, so a stale key stops working everywhere", async () => {
    const keyVerifier = verifierAccepting("real-key");
    const { fetch } = await createTestOrchestrator({ keyVerifier });
    await deploy(fetch, { key: "real-key", body: { slug: "owned" } });

    const revoked = verifierAccepting();
    const after = await createTestOrchestrator({ keyVerifier: revoked });
    const res = await authFetch(after.fetch, "/owned/secret", {
      method: "GET",
      key: "real-key",
    });
    expect(res.status).toBe(401);
  });

  test("no verifier configured keeps the pre-existing behavior (dev and tests)", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await deploy(fetch, { key: "any-string-at-all", body: { slug: "devmode" } });
    expect(res.status).toBe(200);
  });

  test("the verifier is asked for the bearer as sent", async () => {
    const keyVerifier = verifierAccepting("real-key");
    const { fetch } = await createTestOrchestrator({ keyVerifier });
    await deploy(fetch, { key: "real-key", body: { slug: "arg-check" } });
    expect(keyVerifier).toHaveBeenCalledWith("real-key");
  });
});

describe("POST /deploy body concurrency", () => {
  test("a saturated gate answers 503 + Retry-After rather than buffering", async () => {
    // The bound the two SIZE caps cannot express: peak memory was arrival
    // rate times ~164 MB, and arrival rate is the caller's to choose.
    const { promise: block, resolve: unblock } = Promise.withResolvers<void>();
    const { fetch } = await createTestOrchestrator({
      deployBodyConcurrency: 1,
      deployBodyWaitMs: 10,
      // Hold the single slot by stalling inside the handler's store write.
      store: {
        ...(await createTestOrchestrator()).store,
        putAgent: async () => {
          await block;
        },
      } as never,
    });

    const held = deploy(fetch, { key: "k", body: { slug: "holder" } });
    // Let the first request take the slot before the second asks for one.
    // `sleep` is the repo's ONE wait; `new Promise(r => setImmediate(r))` is a
    // fourth spelling of it that `guard-invariants` rules 4 and 19 cannot see.
    await sleep(0);

    const refused = await deploy(fetch, { key: "k", body: { slug: "queued" } });
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);

    unblock();
    await held;

    // ...and the slot comes back, so the gate throttles rather than wedges.
    const after = await deploy(fetch, { key: "k", body: { slug: "after" } });
    expect(after.status).toBe(200);
  });

  test("a slow key verification does not occupy a body slot", async () => {
    // The gate prices a slot in RSS — buffered bytes — and `authMw` buffers
    // nothing: it reads headers, then asks AssemblyAI (5s cap) and Vault. Held
    // BEHIND the gate, two junk bearers took both slots for the length of an
    // AssemblyAI hiccup and every legitimate deploy 503'd behind them. So
    // `authMw` runs in FRONT of it.
    const { promise: stall, resolve: release } = Promise.withResolvers<void>();
    const keyVerifier = vi.fn(async (key: string) => {
      if (key === "slow-key") await stall;
      return true;
    });
    const { fetch } = await createTestOrchestrator({
      keyVerifier,
      deployBodyConcurrency: 1,
      deployBodyWaitMs: 10,
    });

    const stuck = deploy(fetch, { key: "slow-key", body: { slug: "stuck" } });
    await sleep(0);

    // The single slot is still free, because the stalled request has not
    // reached the gate. Under the old order this was a 503.
    const other = await deploy(fetch, { key: "fine", body: { slug: "other" } });
    expect(other.status).toBe(200);

    release();
    await expect(stuck.then((r) => r.status)).resolves.toBe(200);
  });
});

describe("POST /deploy per-IP rate limit", () => {
  test("refuses past the limit, with Retry-After", async () => {
    const deployRateLimiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const { fetch } = await createTestOrchestrator({ deployRateLimiter });
    const headers = { ...authHeaders("k"), "x-forwarded-for": "203.0.113.7" };

    for (let i = 0; i < 2; i++) {
      const ok = await fetch("/deploy", { method: "POST", headers, body: deployBody() });
      expect(ok.status).toBe(200);
    }
    const refused = await fetch("/deploy", { method: "POST", headers, body: deployBody() });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("a different client IP has its own window", async () => {
    const deployRateLimiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const { fetch } = await createTestOrchestrator({ deployRateLimiter });
    const post = (ip: string) =>
      fetch("/deploy", {
        method: "POST",
        headers: { ...authHeaders("k"), "x-forwarded-for": ip },
        body: deployBody(),
      });

    expect((await post("203.0.113.7")).status).toBe(200);
    expect((await post("203.0.113.7")).status).toBe(429);
    expect((await post("203.0.113.8")).status).toBe(200);
  });

  test("a forged X-Forwarded-For prefix does not buy a fresh window", async () => {
    const deployRateLimiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const { fetch } = await createTestOrchestrator({ deployRateLimiter });
    const post = (claimed: string) =>
      fetch("/deploy", {
        method: "POST",
        headers: {
          ...authHeaders("k"),
          // Our proxy appends the real peer on the right; the left is theirs.
          "x-forwarded-for": `${claimed}, 203.0.113.7`,
        },
        body: deployBody(),
      });

    expect((await post("1.1.1.1")).status).toBe(200);
    expect((await post("2.2.2.2")).status).toBe(429);
    expect((await post("3.3.3.3")).status).toBe(429);
  });
});
