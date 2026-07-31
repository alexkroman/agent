// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { authHeaders, createTestOrchestrator, deployBody } from "./test-utils.ts";

describe("orchestrator concurrency", () => {
  test("parallel deploys of different slugs all succeed", async () => {
    const { fetch } = await createTestOrchestrator();
    const slugs = Array.from({ length: 10 }, (_, i) => `agent-${i}`);

    const results = await Promise.all(
      slugs.map((slug) =>
        fetch("/deploy", {
          method: "POST",
          headers: authHeaders(),
          body: deployBody({ slug }),
        }),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
    }
  });

  test("parallel deploys of the same slug by the same owner all succeed", async () => {
    const { fetch } = await createTestOrchestrator();

    // Deploy the same slug concurrently — all should succeed since same owner
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch("/deploy", {
          method: "POST",
          headers: authHeaders("key1"),
          body: deployBody({ slug: "my-agent" }),
        }),
      ),
    );

    // All should succeed (last write wins)
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Agent should still be accessible
    const health = await fetch("/health");
    expect(health.status).toBe(200);
  });

  test("parallel health checks under deploy load", async () => {
    const { fetch } = await createTestOrchestrator();

    // Mix deploy and health check requests
    const deploys = Array.from({ length: 5 }, (_, i) =>
      fetch("/deploy", {
        method: "POST",
        headers: authHeaders(),
        body: deployBody({ slug: `agent-${i}` }),
      }),
    );
    const healthChecks = Array.from({ length: 10 }, () => fetch("/health"));

    const results = await Promise.all([...deploys, ...healthChecks]);

    // All health checks should succeed
    for (const res of results.slice(5)) {
      expect(res.status).toBe(200);
    }
  });

  test("deploy then immediate delete is safe", async () => {
    const { fetch } = await createTestOrchestrator();

    // Deploy first
    const deployRes = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders("key1"),
      body: deployBody({ slug: "my-agent" }),
    });
    expect(deployRes.status).toBe(200);

    // Immediately delete and re-deploy in parallel
    const [deleteRes, redeployRes] = await Promise.all([
      fetch("/my-agent/delete", {
        method: "POST",
        headers: authHeaders("key1"),
      }),
      fetch("/deploy", {
        method: "POST",
        headers: authHeaders("key1"),
        body: deployBody({ slug: "my-agent" }),
      }),
    ]);

    // Both should complete without crashing — exact status depends on ordering
    expect([200, 404].includes(deleteRes.status)).toBe(true);
    expect([200, 403].includes(redeployRes.status)).toBe(true);
  });
});
