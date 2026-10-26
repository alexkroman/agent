// Copyright 2026 the AAI authors. MIT license.
/**
 * The owner routes (`DELETE /:slug`, `/:slug/secret*`, `/:slug/logs`) refuse an
 * IP that keeps failing authentication — `OWNER_AUTH_FAILURE_IP_RATE_LIMIT`.
 *
 * Every fresh bearer costs one AssemblyAI verification, and the negative cache
 * stops only a REPEATED one, so a random key per request was one upstream call
 * per request with nothing in front.
 */
import { expect, test, vi } from "vitest";
import { createTestOrchestrator } from "./_orchestrator-test-utils.ts";
import { deployAgent } from "./_request-test-utils.ts";
import { createAssemblyAiKeyVerifier } from "./api-key-verify.ts";
import { OWNER_AUTH_FAILURE_IP_RATE_LIMIT } from "./rate-limit.ts";

const IP = "203.0.113.7";

function logsRequest(key: string): Request {
  return new Request("http://localhost/any-agent/logs", {
    headers: { Authorization: `Bearer ${key}`, "x-forwarded-for": IP },
  });
}

test("one IP minting junk keys is refused before the verifier is asked again", async () => {
  const upstream = vi.fn(async () => new Response("unauthorized", { status: 401 }));
  const keyVerifier = createAssemblyAiKeyVerifier({ fetchFn: upstream });
  const { fetch } = await createTestOrchestrator({ keyVerifier });

  const statuses: number[] = [];
  for (let i = 0; i < OWNER_AUTH_FAILURE_IP_RATE_LIMIT.limit * 3; i += 1) {
    statuses.push((await fetch(logsRequest(`junk-${i}`))).status);
  }

  expect(statuses).toContain(429);
  // A failure is charged once it has happened, so the one that crosses the
  // limit was itself verified; everything after it is refused unverified.
  expect(upstream.mock.calls.length).toBe(OWNER_AUTH_FAILURE_IP_RATE_LIMIT.limit + 1);
});

test("an owner polling with a valid key is never the one refused", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "polled", "owner-key");

  for (let i = 0; i < OWNER_AUTH_FAILURE_IP_RATE_LIMIT.limit * 3; i += 1) {
    const res = await fetch(
      new Request("http://localhost/polled/logs", {
        headers: { Authorization: "Bearer owner-key", "x-forwarded-for": IP },
      }),
    );
    expect(res.status).toBe(200);
  }
});
