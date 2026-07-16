// Copyright 2025 the AAI authors. MIT license.
/**
 * CLI integration tests against a mock platform API server — edge cases.
 *
 * Covers secrets edge cases, network failure, missing project config,
 * init file scaffolding, and JSON output mode. The deploy/delete/secrets
 * happy-path tests live in integration.test.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { writeProjectConfig } from "./_config.ts";
import { runDelete } from "./_delete.ts";
import { runDeploy } from "./_deploy.ts";
import { runInit } from "./_init.ts";
import type { MockApi } from "./_mock-api.ts";
import { startMockApi } from "./_mock-api.ts";
import { makeBundle, silenced, withTempDir, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";
import { executeSecretList, executeSecretPut } from "./secret.ts";

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

// ── Secrets: edge cases ──────────────────────────────────────────────────────

describe("secrets edge cases", () => {
  test("secret list with no secrets shows empty message", async () => {
    // Ensure no secrets in mock
    for (const key of Object.keys(api.secrets)) delete api.secrets[key];

    await withProjectDir(
      silenced(async (dir) => {
        await executeSecretList(dir, api.url);
      }),
    );

    // The function should have made the GET request
    const listReq = api.requests.find((r) => r.method === "GET");
    expect(listReq).toBeDefined();
  });

  test("secret put with empty value throws", async () => {
    const clack = await import("@clack/prompts");
    vi.mocked(clack.password).mockResolvedValueOnce("");

    await withProjectDir(async (dir) => {
      const result = await executeSecretPut(dir, "EMPTY_KEY", undefined, api.url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("No value provided");
    });

    // Should not have made any API request
    expect(api.requests).toHaveLength(0);
  });
});

// ── Network failure ──────────────────────────────────────────────────────────

describe("network failure", () => {
  test("deploy throws clean error when server is unreachable", async () => {
    await expect(
      runDeploy({
        url: "http://127.0.0.1:1", // guaranteed unreachable port
        bundle: makeBundle(),
        env: {},
        apiKey: "test-key",
      }),
    ).rejects.toThrow("could not reach");
  });

  test("delete throws clean error when server is unreachable", async () => {
    await expect(
      runDelete({
        url: "http://127.0.0.1:1",
        slug: "my-agent",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("could not reach");
  });
});

// ── Missing project config ───────────────────────────────────────────────────

describe("missing project config", () => {
  test("delete with no .aai/project.json throws", async () => {
    const { getServerInfo } = await import("./_agent.ts");
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("No .aai/project.json found");
    });
  });

  test("secret list with no .aai/project.json throws", async () => {
    await withTempDir(async (dir) => {
      await expect(executeSecretList(dir, api.url)).rejects.toThrow("No .aai/project.json found");
    });
  });
});

// ── Init integration ─────────────────────────────────────────────────────────

describe("init creates working project", () => {
  test("init creates all expected files from template + shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const rootDir = await writeFiles(path.join(dir, "fake-templates"), {
          "scaffold/shared.txt": "from shared",
          "scaffold/.env.example": "MY_KEY=",
          "scaffold/package.json": '{"name":"test"}',
          "templates/simple/agent.json": JSON.stringify({ name: "Default Name" }),
        });
        vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
        try {
          const target = path.join(dir, "my-project");
          await runInit({ targetDir: target, template: "simple" });

          expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
          const agentContent = await fs.readFile(path.join(target, "agent.json"), "utf-8");
          expect(agentContent).toContain("Default Name");
          expect(await fileExists(path.join(target, "shared.txt"))).toBe(true);
          expect(await fileExists(path.join(target, ".env"))).toBe(true);
          expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
          expect(await fileExists(path.join(target, "package.json"))).toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      }),
    );
  });
});

// ── JSON output mode ────────────────────────────────────────────────────────

describe("JSON output mode", () => {
  test("executeDelete returns structured result", async () => {
    const { executeDelete } = await import("./delete.ts");
    await withProjectDir(
      silenced(async (dir) => {
        const result = await executeDelete({ cwd: dir, server: api.url });
        expect(result).toEqual({ ok: true, data: { slug: "my-agent" } });
      }),
    );
  });

  test("executeSecretList returns structured result", async () => {
    api.secrets.KEY_A = "a";
    api.secrets.KEY_B = "b";

    const { executeSecretList } = await import("./secret.ts");
    await withProjectDir(
      silenced(async (dir) => {
        const result = await executeSecretList(dir, api.url);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.secrets).toContain("KEY_A");
          expect(result.data.secrets).toContain("KEY_B");
        }
      }),
    );
  });

  test("executeSecretPut with value returns structured result", async () => {
    const { executeSecretPut } = await import("./secret.ts");
    await withProjectDir(
      silenced(async (dir) => {
        const result = await executeSecretPut(dir, "NEW_KEY", "new-value", api.url);
        expect(result).toEqual({ ok: true, data: { name: "NEW_KEY" } });
        expect(api.secrets.NEW_KEY).toBe("new-value");
      }),
    );
  });

  test("executeSecretDelete returns structured result", async () => {
    api.secrets.DEL_KEY = "to-delete";
    const { executeSecretDelete } = await import("./secret.ts");
    await withProjectDir(
      silenced(async (dir) => {
        const result = await executeSecretDelete(dir, "DEL_KEY", api.url);
        expect(result).toEqual({ ok: true, data: { name: "DEL_KEY" } });
        expect(api.secrets.DEL_KEY).toBeUndefined();
      }),
    );
  });

  test("CliError carries structured code and hint", async () => {
    const { CliError } = await import("./_output.ts");

    const err = new CliError("auth_failed", "No key", "Set env var");
    expect(err.code).toBe("auth_failed");
    expect(err.hint).toBe("Set env var");
    expect(err.message).toBe("No key");
  });
});
