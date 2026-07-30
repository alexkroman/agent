// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for bundle-store upstream (blob storage) call instrumentation metrics.
 * Core bundle-store behavior tests live in bundle-store.test.ts.
 */
import { createStorage } from "unstorage";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createBundleStore } from "./bundle-store.ts";
import { registry } from "./metrics.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { counterValue, TEST_AGENT_CONFIG } from "./test-utils.ts";

// ── Storage instrumentation ───────────────────────────────────────────────

describe("bundle-store metrics", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });
  afterEach(() => {
    registry.resetMetrics();
  });

  test("instruments getManifest with status=ok on a hit", async () => {
    const storage = createStorage();
    const store = createBundleStore(storage, { secrets: createMemorySecretStore() });

    await store.putAgent({
      slug: "agent-ok",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: ["h"],
      agentConfig: TEST_AGENT_CONFIG,
    });
    // Bypass the manifest cache by reading first time:
    await store.getManifest("agent-ok");

    expect(
      counterValue("aai_upstream_call_total", {
        upstream: "storage",
        op: "getManifest",
        status: "ok",
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("instruments getManifest with status=ok even for null lookups", async () => {
    const storage = createStorage();
    const store = createBundleStore(storage, { secrets: createMemorySecretStore() });

    await store.getManifest("does-not-exist");

    // null result is still a successful upstream call
    expect(
      counterValue("aai_upstream_call_total", {
        upstream: "storage",
        op: "getManifest",
        status: "ok",
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("instruments putAgent with status=ok", async () => {
    const storage = createStorage();
    const store = createBundleStore(storage, { secrets: createMemorySecretStore() });

    await store.putAgent({
      slug: "agent-put",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: ["h"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    expect(
      counterValue("aai_upstream_call_total", {
        upstream: "storage",
        op: "putAgent",
        status: "ok",
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("instruments deleteAgent with status=ok", async () => {
    const storage = createStorage();
    const store = createBundleStore(storage, { secrets: createMemorySecretStore() });

    await store.deleteAgent("missing-agent");
    expect(
      counterValue("aai_upstream_call_total", {
        upstream: "storage",
        op: "deleteAgent",
        status: "ok",
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("instruments putEnv with status=error when manifest missing", async () => {
    const storage = createStorage();
    const store = createBundleStore(storage, { secrets: createMemorySecretStore() });

    await expect(store.putEnv("no-such-agent", { K: "V" })).rejects.toThrow();
    expect(
      counterValue("aai_upstream_call_total", {
        upstream: "storage",
        op: "putEnv",
        status: "error",
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});
