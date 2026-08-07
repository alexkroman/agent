// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { MAX_WORKER_SIZE } from "./constants.ts";
import { authHeaders, createTestOrchestrator, deployAgent } from "./test-utils.ts";

// ── E2E HTTP Malformed Payload Rejection ───────────────────────────────

describe("e2e HTTP malformed payload rejection", () => {
  test("deploy rejects non-JSON body", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: "this is not json",
    });
    expect(res.status).toBe(400);
  });

  test("secret update rejects non-JSON body", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret", {
      method: "PUT",
      headers: authHeaders(),
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("deploy rejects array body", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify([{ worker: "code" }]),
    });
    expect(res.status).toBe(400);
  });

  test("deploy rejects extra-large worker code", async () => {
    const { fetch } = await createTestOrchestrator();

    // MAX_WORKER_SIZE is enforced by the schema
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        env: { MY_SECRET: "value" },
        worker: "x".repeat(MAX_WORKER_SIZE + 1),
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

    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  test("secret endpoint rejects invalid secret payload", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ "invalid-key-name!": "value" }),
    });
    expect(res.status).toBe(400);
  });
});
