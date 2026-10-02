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
import { describe, expect, vi } from "vitest";
import { runDeploy } from "./_deploy.ts";
import { runInit } from "./_init.ts";
import { test } from "./_mock-api-test-utils.ts";
import { makeBundle, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";
import { runDelete } from "./delete.ts";
import { executeSecretList, executeSecretPut } from "./secret.ts";

// ── Secrets: edge cases ──────────────────────────────────────────────────────

describe("secrets edge cases", () => {
  test("secret list with no secrets returns an empty result", async ({
    api,
    ui,
    projectDir: dir,
  }) => {
    // Ensure no secrets in mock
    for (const key of Object.keys(api.secrets)) delete api.secrets[key];

    const result = await executeSecretList(dir, api.url, ui);

    // Assert the behavior (an ok, empty list), not just that a GET happened.
    expect(result).toEqual({ ok: true, data: { secrets: [] } });
  });

  test("secret put with empty value throws", async ({ ui, api, projectDir: dir }) => {
    ui.prompts.password.mockResolvedValueOnce("");

    const result = await executeSecretPut(dir, "EMPTY_KEY", undefined, api.url, ui);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No value provided");

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
        // The assertion is on the error, not the backoff — don't sleep 2×300ms.
        retryDelay: 0,
      }),
    ).rejects.toThrow("could not reach");
  });

  test("delete throws clean error when server is unreachable", async () => {
    await expect(
      runDelete({
        url: "http://127.0.0.1:1",
        slug: "my-agent",
        apiKey: "test-key",
        retryDelay: 0,
      }),
    ).rejects.toThrow("could not reach");
  });
});

// ── Missing project config ───────────────────────────────────────────────────

describe("missing project config", () => {
  // `api` logs in: without it the key check fires first, and the test passed
  // only when an earlier test's `api` had left a key in the file's config dir.
  test("delete with no .aai/project.json throws", async ({ api: _api, tmpDir: dir }) => {
    const { getServerInfo } = await import("./_agent.ts");
    await expect(getServerInfo(dir)).rejects.toThrow("no deployed agent");
  });

  test("secret list with no .aai/project.json throws", async ({ api, ui, tmpDir: dir }) => {
    await expect(executeSecretList(dir, api.url, ui)).rejects.toThrow("no deployed agent");
  });
});

// ── Init integration ─────────────────────────────────────────────────────────

describe("init creates working project", () => {
  test("init creates all expected files from template + shared", async ({ tmpDir: dir }) => {
    const rootDir = await writeFiles(path.join(dir, "fake-templates"), {
      "scaffold/shared.txt": "from shared",
      "scaffold/.env.example": "MY_KEY=",
      "scaffold/package.json": '{"name":"test"}',
      "templates/quickstart-agent/agent.json": JSON.stringify({ name: "Default Name" }),
    });
    vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
    const target = path.join(dir, "my-project");
    await runInit({ targetDir: target, template: "quickstart-agent" });

    expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
    const agentContent = await fs.readFile(path.join(target, "agent.json"), "utf-8");
    expect(agentContent).toContain("Default Name");
    expect(await fileExists(path.join(target, "shared.txt"))).toBe(true);
    expect(await fileExists(path.join(target, ".env"))).toBe(true);
    expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
    expect(await fileExists(path.join(target, "package.json"))).toBe(true);
  });
});

// ── JSON output mode ────────────────────────────────────────────────────────

describe("JSON output mode", () => {
  test("executeDelete returns structured result", async ({ api, ui, projectDir: dir }) => {
    const { executeDelete } = await import("./delete.ts");
    const result = await executeDelete({ cwd: dir, server: api.url }, ui);
    expect(result).toEqual({ ok: true, data: { slug: "my-agent" } });
  });

  test("executeSecretList returns structured result", async ({ api, ui, projectDir: dir }) => {
    api.secrets.KEY_A = "a";
    api.secrets.KEY_B = "b";

    const { executeSecretList } = await import("./secret.ts");
    const result = await executeSecretList(dir, api.url, ui);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toContain("KEY_A");
      expect(result.data.secrets).toContain("KEY_B");
    }
  });

  test("executeSecretPut with value returns structured result", async ({
    api,
    ui,
    projectDir: dir,
  }) => {
    const { executeSecretPut } = await import("./secret.ts");
    const result = await executeSecretPut(dir, "NEW_KEY", "new-value", api.url, ui);
    expect(result).toEqual({ ok: true, data: { name: "NEW_KEY" } });
    expect(api.secrets.NEW_KEY).toBe("new-value");
  });

  test("executeSecretDelete returns structured result", async ({ api, ui, projectDir: dir }) => {
    api.secrets.DEL_KEY = "to-delete";
    const { executeSecretDelete } = await import("./secret.ts");
    const result = await executeSecretDelete(dir, "DEL_KEY", api.url, ui);
    expect(result).toEqual({ ok: true, data: { name: "DEL_KEY" } });
    expect(api.secrets.DEL_KEY).toBeUndefined();
  });

  test("CliError carries structured code and hint", async () => {
    const { CliError } = await import("./_output.ts");

    const err = new CliError("auth_failed", "No key", "Set env var");
    expect(err.code).toBe("auth_failed");
    expect(err.hint).toBe("Set env var");
    expect(err.message).toBe("No key");
  });
});
