// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { authHeaders, createTestOrchestrator, deploy } from "./test-utils.ts";

describe("orchestrator concurrency", () => {
  test("parallel deploys of different slugs all succeed", async () => {
    const { fetch } = await createTestOrchestrator();
    const slugs = Array.from({ length: 10 }, (_, i) => `agent-${i}`);

    const results = await Promise.all(slugs.map((slug) => deploy(fetch, { body: { slug } })));

    for (const res of results) {
      expect(res.status).toBe(200);
    }
  });

  test("parallel deploys of the same slug by the same owner all succeed", async () => {
    const { fetch } = await createTestOrchestrator();

    // Deploy the same slug concurrently — all should succeed since same owner
    const results = await Promise.all(
      Array.from({ length: 5 }, () => deploy(fetch, { key: "key1", body: { slug: "my-agent" } })),
    );

    // All should succeed (last write wins)
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // The AGENT is still accessible — `/health` is the platform's own static
    // route, which answers 200 whether or not this deploy ever landed, so it
    // said nothing about the thing this test is named for. `/my-agent/health`
    // 404s unless the agents row is really there.
    const health = await fetch("/my-agent/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", slug: "my-agent" });
  });

  test("parallel health checks under deploy load", async () => {
    const { fetch } = await createTestOrchestrator();

    // Mix deploy and health check requests
    const deploys = Array.from({ length: 5 }, (_, i) =>
      deploy(fetch, { body: { slug: `agent-${i}` } }),
    );
    const healthChecks = Array.from({ length: 10 }, () => fetch("/health"));

    // Both halves are asserted. Slicing the combined array and checking only
    // the tail meant a deploy path that 500s under concurrency — the load this
    // test exists to apply — passed.
    const [deployResults, healthResults] = await Promise.all([
      Promise.all(deploys),
      Promise.all(healthChecks),
    ]);

    for (const res of deployResults) {
      expect(res.status).toBe(200);
    }
    for (const res of healthResults) {
      expect(res.status).toBe(200);
    }
  });

  test("deploy racing an immediate delete leaves no torn state", async () => {
    const { fetch, store } = await createTestOrchestrator();

    // Deploy first
    const deployRes = await deploy(fetch, { key: "key1", body: { slug: "my-agent" } });
    expect(deployRes.status).toBe(200);

    // Immediately delete and re-deploy in parallel. Deletion is `DELETE /:slug`
    // — this used to POST to `/my-agent/delete`, a route that has never
    // existed, so every run fell through to `notFound` and the `[200, 404]`
    // assertion accepted it.
    const [deleteRes, redeployRes] = await Promise.all([
      fetch("/my-agent", { method: "DELETE", headers: authHeaders("key1") }),
      deploy(fetch, { key: "key1", body: { slug: "my-agent" } }),
    ]);

    // Neither ordering can fail: the delete removes an agent this key owns, and
    // the deploy either re-claims the slug it just freed (an unclaimed slug goes
    // to whoever asks) or overwrites a row the same key owns. Anything but 200
    // is a defect, not an ordering artefact.
    expect(deleteRes.status).toBe(200);
    expect(redeployRes.status).toBe(200);

    // Whichever way it went, the route and the store must agree about whether
    // the agent survived — a half-committed delete is what this race can break.
    const health = await fetch("/my-agent/health");
    const record = await store.getAgent("my-agent");
    expect(health.status).toBe(record ? 200 : 404);
  });
});
