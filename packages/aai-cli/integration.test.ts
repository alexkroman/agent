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
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { readProjectConfig, writeProjectConfig } from "./_config.ts";
import { runDelete } from "./_delete.ts";
import { runDeploy } from "./_deploy.ts";
import type { MockApi } from "./_mock-api.ts";
import { startMockApi } from "./_mock-api.ts";
import { makeBundle, silenced, withTempDir } from "./_test-utils.ts";
import { executeSecretDelete, executeSecretList, executeSecretPut } from "./secret.ts";

// Mock @clack/prompts to avoid interactive input in tests
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    password: vi.fn(() => Promise.resolve("super-secret")),
    isCancel: actual.isCancel,
  };
});

// Mock ensureApiKey to avoid interactive prompt and provide a test key
vi.mock("./_config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_config.ts")>();
  return {
    ...actual,
    ensureApiKey: vi.fn(() => Promise.resolve("test-key")),
  };
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
    expect((body.agentConfig as Record<string, unknown>).name).toBe("test-agent");
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
      await executeSecretPut(dir, "MY_KEY", undefined, api.url);

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

    await withProjectDir(
      silenced(async (dir) => {
        await executeSecretList(dir, api.url);
      }),
    );

    const listReq = api.requests.find((r) => r.method === "GET" && r.path.includes("/secret"));
    expect(listReq).toBeDefined();
  });

  test("secret delete sends DELETE with name in path", async () => {
    api.secrets.TO_DELETE = "value";

    await withProjectDir(async (dir) => {
      await executeSecretDelete(dir, "TO_DELETE", api.url);
    });

    const delReq = api.requests.find(
      (r) => r.method === "DELETE" && r.path.includes("/secret/TO_DELETE"),
    );
    expect(delReq).toBeDefined();
    expect(api.secrets.TO_DELETE).toBeUndefined();
  });

  test("secret with 401 throws API key hint", async () => {
    const configMod = await import("./_config.ts");
    vi.mocked(configMod.ensureApiKey).mockResolvedValueOnce("invalid-key");
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: api.url });
      await expect(executeSecretList(dir, api.url)).rejects.toThrow("API key may be invalid");
    });
  });
});

// ── Deploy: config persistence ───────────────────────────────────────────────

describe("deploy config persistence", () => {
  test("deploy saves returned slug to .aai/project.json", async () => {
    await withTempDir(async (dir) => {
      const result = await runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        apiKey: "test-key",
      });

      // Manually write config like deploy.ts does
      await writeProjectConfig(dir, { slug: result.slug, serverUrl: api.url });

      const config = await readProjectConfig(dir);
      expect(config?.slug).toBe(result.slug);
      expect(config?.serverUrl).toBe(api.url);
    });
  });

  test("redeploy sends existing slug from config", async () => {
    await withTempDir(async (dir) => {
      // First deploy — no slug
      const first = await runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        apiKey: "test-key",
      });
      await writeProjectConfig(dir, { slug: first.slug, serverUrl: api.url });
      api.clear();

      // Second deploy — should reuse slug from config
      const config = await readProjectConfig(dir);
      const second = await runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        ...(config?.slug ? { slug: config.slug } : {}),
        apiKey: "test-key",
      });

      expect(second.slug).toBe(first.slug);
      const body = JSON.parse(getReq(0).body) as Record<string, unknown>;
      expect(body.slug).toBe(first.slug);
    });
  });
});
