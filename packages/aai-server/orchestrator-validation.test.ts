// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createTestOrchestrator, deployAgent, TEST_AGENT_CONFIG } from "./test-utils.ts";

// ── E2E HTTP Malformed Payload Rejection ───────────────────────────────

describe("e2e HTTP malformed payload rejection", () => {
  test("deploy rejects non-JSON body", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: "this is not json",
    });
    expect(res.status).toBe(400);
  });

  test("KV endpoint rejects non-JSON body", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("secret update rejects non-JSON body", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret", {
      method: "PUT",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("deploy rejects array body", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ worker: "code" }]),
    });
    expect(res.status).toBe(400);
  });

  test("deploy rejects extra-large worker code", async () => {
    const { fetch } = await createTestOrchestrator();

    // MAX_WORKER_SIZE is enforced by the schema
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        env: { MY_SECRET: "value" },
        worker: "x".repeat(20_000_001), // Likely exceeds MAX_WORKER_SIZE
        clientFiles: {},
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ── HTTP Endpoint Schema Validation ────────────────────────────────────

describe("HTTP endpoint schema validation", () => {
  test("deploy endpoint rejects invalid deploy body with 400", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  test("secret endpoint rejects invalid secret payload", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret", {
      method: "PUT",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ "invalid-key-name!": "value" }),
    });
    expect(res.status).toBe(400);
  });

  test("KV endpoint rejects invalid request body", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "invalid_op", key: "test" }),
    });
    expect(res.status).toBe(400);
  });

  test("KV endpoint rejects missing op field", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: "test" }),
    });
    expect(res.status).toBe(400);
  });

  test("deploy rejects missing ASSEMBLYAI_API_KEY", async () => {
    const { fetch } = await createTestOrchestrator();

    // First deploy (unclaimed slug) with no ASSEMBLYAI_API_KEY
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        env: { ONLY_USER_SECRET: "val" },
        worker:
          'export default { name: "test", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid platform config");
  });
});
