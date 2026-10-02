// Copyright 2025 the AAI authors. MIT license.
/**
 * CLI integration tests against a mock platform API server.
 *
 * Starts a real HTTP server that mimics the AAI platform API, then exercises
 * CLI commands (deploy, delete, secrets) against it. Tests the full request
 * path: CLI function → apiRequest → HTTP → mock server → response handling.
 *
 * Edge cases (network failure, missing config, init, JSON output) live in
 * integration-edge-cases.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { updateGlobalConfig, writeProjectConfig } from "./_config.ts";
import { runDeploy } from "./_deploy.ts";
import type { MockApi } from "./_mock-api.ts";
import { startMockApi } from "./_mock-api.ts";
import { createFakeUi, type FakeUi, makeBundle, silenced, withTempDir } from "./_test-utils.ts";
import { runDelete } from "./delete.ts";
import { executeSecretDelete, executeSecretList, executeSecretPut } from "./secret.ts";

// The terminal the commands are handed: its masked prompt answers a fixed
// value, so `secret put` with no stdin value has something to store.
let ui: FakeUi;
beforeEach(() => {
  ui = createFakeUi();
  ui.prompts.password.mockResolvedValue("super-secret");
});

// A REAL login key in this run's config dir (`_test-setup.ts` points
// AAI_CONFIG_DIR at a temp dir), so `ensureApiKey` runs unmocked.
beforeAll(async () => {
  await updateGlobalConfig((config) => ({ ...config, apiKey: "test-key" }));
});

/** Get a request from the recorded list, throwing if it doesn't exist. */
function getReq(index: number) {
  const r = api.requests[index];
  if (!r) throw new Error(`No request at index ${index}`);
  return r;
}

async function withProjectDir(fn: (dir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await writeProjectConfig(dir, { slug: "my-agent", serverUrl: api.url });
    await fn(dir);
  });
}

let api: MockApi;

beforeAll(async () => {
  api = await startMockApi();
});

afterEach(() => {
  api.clear();
});

afterAll(async () => {
  await api.stop();
});

// ── Deploy ───────────────────────────────────────────────────────────────────

describe("deploy against mock API", () => {
  test("successful deploy sends POST /deploy with auth and body", async () => {
    const result = await runDeploy({
      url: api.url,
      bundle: makeBundle(),
      env: { ASSEMBLYAI_API_KEY: "key-123" },
      slug: "my-agent",
      apiKey: "test-key",
    });

    expect(result.slug).toBe("my-agent");
    expect(api.requests).toHaveLength(1);

    const req = getReq(0);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/deploy");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.slug).toBe("my-agent");
    expect(body.worker).toBeTruthy();
    expect(body.clientFiles).toEqual({});
    expect(body).not.toHaveProperty("agentConfig");
    expect((body.env as Record<string, string>).ASSEMBLYAI_API_KEY).toBe("key-123");
  });

  test("first deploy without slug gets server-generated slug", async () => {
    const result = await runDeploy({
      url: api.url,
      bundle: makeBundle(),
      env: {},
      apiKey: "test-key",
    });

    // Server generates a slug when none provided
    expect(result.slug).toMatch(/^generated-/);
    const body = JSON.parse(getReq(0).body) as Record<string, unknown>;
    expect(body.slug).toBeUndefined();
  });

  test("401 throws with API key hint", async () => {
    await expect(
      runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        slug: "my-agent",
        apiKey: "invalid-key",
      }),
    ).rejects.toThrow("API key may be invalid");
  });

  test("413 throws with bundle size hint", async () => {
    api.override("POST", "/deploy", 413, "payload too large");
    await expect(
      runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        slug: "my-agent",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("bundle is too large");
  });

  test("500 throws with status and body", async () => {
    api.override("POST", "/deploy", 500, "internal error");
    await expect(
      runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        slug: "my-agent",
        apiKey: "test-key",
        retryDelay: 0,
      }),
    ).rejects.toThrow("deploy failed (HTTP 500)");
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe("delete against mock API", () => {
  test("successful delete sends DELETE with auth", async () => {
    await runDelete({
      url: api.url,
      slug: "my-agent",
      apiKey: "test-key",
    });

    expect(api.requests).toHaveLength(1);
    const req = getReq(0);
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/my-agent");
    expect(req.headers.authorization).toBe("Bearer test-key");
  });

  test("401 throws with API key hint", async () => {
    await expect(
      runDelete({ url: api.url, slug: "my-agent", apiKey: "invalid-key" }),
    ).rejects.toThrow("API key may be invalid");
  });

  test("404 throws with not-deployed hint", async () => {
    api.override("DELETE", "/ghost-agent", 404, "not found");
    await expect(
      runDelete({ url: api.url, slug: "ghost-agent", apiKey: "test-key" }),
    ).rejects.toThrow("may not be deployed");
  });
});

// ── Secrets ──────────────────────────────────────────────────────────────────

describe("secrets against mock API", () => {
  // Secret commands use getServerInfo which reads .aai/project.json.
  // We need a real temp directory with a project config pointing at the mock API.

  test("secret put sends PUT with name/value body", async () => {
    await withProjectDir(async (dir) => {
      await executeSecretPut(dir, "MY_KEY", undefined, api.url, ui);

      const putReq = api.requests.find((r) => r.method === "PUT" && r.path.includes("/secret"));
      expect(putReq).toBeDefined();
      const body = JSON.parse(putReq?.body ?? "{}") as Record<string, string>;
      expect(body.MY_KEY).toBe("super-secret");
    });

    // Verify it was stored in the mock
    expect(api.secrets.MY_KEY).toBe("super-secret");
  });

  test("secret list returns stored secrets", async () => {
    // Pre-populate secrets
    api.secrets.SECRET_A = "a";
    api.secrets.SECRET_B = "b";

    // The RESULT is the subject, not the request: a regression that answered
    // `{ secrets: [] }` still sends a GET, so asserting only that a GET
    // happened is a test of the mock server rather than of the command.
    let result: Awaited<ReturnType<typeof executeSecretList>> | undefined;
    await withProjectDir(
      silenced(async (dir) => {
        result = await executeSecretList(dir, api.url, ui);
      }),
    );

    const listReq = api.requests.find((r) => r.method === "GET" && r.path.includes("/secret"));
    expect(listReq).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.ok === true ? result.data.secrets : undefined).toEqual(
      expect.arrayContaining(["SECRET_A", "SECRET_B"]),
    );
  });

  test("secret delete sends DELETE with name in path", async () => {
    api.secrets.TO_DELETE = "value";

    await withProjectDir(async (dir) => {
      await executeSecretDelete(dir, "TO_DELETE", api.url, ui);
    });

    const delReq = api.requests.find(
      (r) => r.method === "DELETE" && r.path.includes("/secret/TO_DELETE"),
    );
    expect(delReq).toBeDefined();
    expect(api.secrets.TO_DELETE).toBeUndefined();
  });

  test("secret delete URL-encodes hostile names", async () => {
    await withProjectDir(async (dir) => {
      // A name containing `/` must not become extra path segments.
      await executeSecretDelete(dir, "A/B", api.url, ui).catch(() => undefined);
      const delReq = api.requests.find((r) => r.method === "DELETE");
      expect(delReq?.path).toBe("/my-agent/secret/A%2FB");
    });
  });

  test("a hostile slug from .aai/project.json is rejected before any request", async () => {
    await withTempDir(async (dir) => {
      // Repo-controlled input: `..`/`/` shaped slugs would otherwise steer a
      // credentialed request to an arbitrary path on an approved origin.
      await writeProjectConfig(dir, { slug: "x/../admin", serverUrl: api.url });
      await expect(executeSecretList(dir, api.url, ui)).rejects.toThrow(/Invalid slug/);
      expect(api.requests).toHaveLength(0);
    });
  });

  test("secret with 401 throws API key hint", async () => {
    await updateGlobalConfig((config) => ({ ...config, apiKey: "invalid-key" }));
    try {
      await withTempDir(async (dir) => {
        await writeProjectConfig(dir, { slug: "my-agent", serverUrl: api.url });
        await expect(executeSecretList(dir, api.url, ui)).rejects.toThrow("API key may be invalid");
      });
    } finally {
      await updateGlobalConfig((config) => ({ ...config, apiKey: "test-key" }));
    }
  });
});
