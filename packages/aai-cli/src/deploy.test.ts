// Copyright 2025 the AAI authors. MIT license.
/**
 * `executeDeploy`, the full command composition, against the mock platform
 * API. The upload itself (`runDeploy`: gzip, headers, retries, hints) is
 * `_deploy.test.ts`.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import { readProjectConfig } from "./_config.ts";
import type { MockApi } from "./_mock-api.ts";
import { test } from "./_mock-api-test-utils.ts";
import { projectNameFromDir } from "./_studio.ts";
import { linkSdkNodeModules } from "./_test-utils.ts";

/** Get a request from the recorded list, throwing if it doesn't exist. */
function getReq(api: MockApi, index: number) {
  const r = api.requests[index];
  if (!r) throw new Error(`No request at index ${index}`);
  return r;
}

// ── executeDeploy: the full command composition ─────────────────────────────
//
// These exercise the REAL deploy path (target resolution → bundling →
// upload → config write), not hand-rolled equivalents: the old "config
// persistence" tests wrote .aai/project.json themselves "like deploy.ts
// does" and kept passing with executeDeploy deleted entirely.

// Each deploy here bundles the SDK runtime into the worker (the deploy
// artifact shape), which takes seconds under parallel suite load.
describe("executeDeploy end to end", { timeout: 120_000 }, () => {
  /** Scaffold a minimal agent project in `dir`. */
  async function writeAgentProject(dir: string): Promise<void> {
    await linkSdkNodeModules(dir);
    await writeFile(
      path.join(dir, "agent.ts"),
      `export default { name: "deploy-test-agent", systemPrompt: "Test", tools: {} };`,
    );
  }

  test("names a first deploy after the directory and records the slug", async ({
    api,
    ui,
    tmpDir: dir,
  }) => {
    await writeAgentProject(dir);
    const { executeDeploy } = await import("./deploy.ts");
    const result = await executeDeploy({ cwd: dir, server: api.url }, ui);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // First deploy: the directory names the agent, through the same
    // `projectNameFromDir` rule `aai push` uses for a project name. That
    // is the platform's slugifier, so the assertion goes through it too
    // rather than re-deriving the transform — the temp dir is
    // `aai_test_<random>`, and its `_`s collapse to `-`.
    expect(result.data.slug).toBe(projectNameFromDir(dir));
    expect(result.data.slug).toBe(path.basename(dir).toLowerCase().replaceAll("_", "-"));
    // It MUST be recorded, or the next deploy would mint a fresh
    // slug and orphan this agent.
    const config = await readProjectConfig(dir);
    expect(config?.slug).toBe(result.data.slug);
    expect(config?.serverUrl).toBe(api.url);
  });

  test("redeploy reuses the recorded slug", async ({ api, ui, tmpDir: dir }) => {
    await writeAgentProject(dir);
    const { executeDeploy } = await import("./deploy.ts");
    const first = await executeDeploy({ cwd: dir, server: api.url }, ui);
    if (!first.ok) throw new Error("first deploy failed");
    api.clear();

    const second = await executeDeploy({ cwd: dir, server: api.url }, ui);
    if (!second.ok) throw new Error("second deploy failed");
    expect(second.data.slug).toBe(first.data.slug);
    const body = JSON.parse(getReq(api, 0).body) as Record<string, unknown>;
    expect(body.slug).toBe(first.data.slug);
  });

  test("an ASSEMBLYAI_API_KEY declared in .env wins over the login key", async ({
    api,
    ui,
    tmpDir: dir,
  }) => {
    // Shell env would take precedence over the .env file value — isolate
    // from a developer machine's exported key.
    vi.stubEnv("ASSEMBLYAI_API_KEY", undefined);
    await writeAgentProject(dir);
    // The user deliberately targets a different account in .env; the
    // login key is a floor, not an override.
    await writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=user-dot-env-key\n");
    const { executeDeploy } = await import("./deploy.ts");
    const result = await executeDeploy({ cwd: dir, server: api.url }, ui);

    expect(result.ok).toBe(true);
    const body = JSON.parse(getReq(api, 0).body) as { env: Record<string, string> };
    expect(body.env.ASSEMBLYAI_API_KEY).toBe("user-dot-env-key");
  });

  test("without .env the login key is seeded as ASSEMBLYAI_API_KEY", async ({
    api,
    ui,
    tmpDir: dir,
  }) => {
    await writeAgentProject(dir);
    const { executeDeploy } = await import("./deploy.ts");
    await executeDeploy({ cwd: dir, server: api.url }, ui);

    const body = JSON.parse(getReq(api, 0).body) as { env: Record<string, string> };
    expect(body.env.ASSEMBLYAI_API_KEY).toBe("test-key");
  });
});
