// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { authHeaders, createTestOrchestrator, deployBody } from "./test-utils.ts";

describe("orchestrator concurrency", () => {
  test("parallel deploys of different slugs all succeed", async () => {
    const { fetch } = await createTestOrchestrator();
    const slugs = Array.from({ length: 10 }, (_, i) => `agent-${i}`);

    const results = await Promise.all(
      slugs.map((slug) =>
        fetch(`/${slug}/deploy`, {
          method: "POST",
          headers: authHeaders(),
          body: deployBody(),
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
        fetch("/my-agent/deploy", {
          method: "POST",
          headers: authHeaders("key1"),
          body: deployBody(),
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
      fetch(`/agent-${i}/deploy`, {
        method: "POST",
        headers: authHeaders(),
        body: deployBody(),
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
    const deployRes = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: authHeaders("key1"),
      body: deployBody(),
    });
    expect(deployRes.status).toBe(200);

    // Immediately delete and re-deploy in parallel
    const [deleteRes, redeployRes] = await Promise.all([
      fetch("/my-agent/delete", {
        method: "POST",
        headers: authHeaders("key1"),
      }),
      fetch("/my-agent/deploy", {
        method: "POST",
        headers: authHeaders("key1"),
        body: deployBody(),
      }),
    ]);

    // Both should complete without crashing — exact status depends on ordering
    expect([200, 404].includes(deleteRes.status)).toBe(true);
    expect([200, 403].includes(redeployRes.status)).toBe(true);
  });

  test("concurrent KV operations across different agents", async () => {
    const { fetch } = await createTestOrchestrator();

    // Deploy two agents
    await Promise.all([
      fetch("/agent-a/deploy", {
        method: "POST",
        headers: authHeaders("key-a"),
        body: deployBody(),
      }),
      fetch("/agent-b/deploy", {
        method: "POST",
        headers: authHeaders("key-b"),
        body: deployBody(),
      }),
    ]);

    // Concurrent KV operations on both agents
    const kvOps = await Promise.all([
      fetch("/agent-a/kv", {
        method: "POST",
        headers: authHeaders("key-a"),
        body: JSON.stringify({ op: "set", key: "k", value: "val-a" }),
      }),
      fetch("/agent-b/kv", {
        method: "POST",
        headers: authHeaders("key-b"),
        body: JSON.stringify({ op: "set", key: "k", value: "val-b" }),
      }),
    ]);

    for (const res of kvOps) {
      expect(res.status).toBe(200);
    }

    // Read back — should be isolated
    const [getA, getB] = await Promise.all([
      fetch("/agent-a/kv", {
        method: "POST",
        headers: authHeaders("key-a"),
        body: JSON.stringify({ op: "get", key: "k" }),
      }),
      fetch("/agent-b/kv", {
        method: "POST",
        headers: authHeaders("key-b"),
        body: JSON.stringify({ op: "get", key: "k" }),
      }),
    ]);

    const jsonA = (await getA.json()) as { result: unknown };
    const jsonB = (await getB.json()) as { result: unknown };
    expect(jsonA.result).toBe("val-a");
    expect(jsonB.result).toBe("val-b");
  });
});
