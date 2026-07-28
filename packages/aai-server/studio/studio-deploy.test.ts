// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createSlotCache } from "../sandbox-slots.ts";
import { hashApiKey } from "../secrets.ts";
import { createTestStorage, createTestStore, TEST_AGENT_CONFIG } from "../test-utils.ts";
import { StudioBuildError } from "./studio-bundle.ts";
import { deployStudioProject, type StudioDeployDeps } from "./studio-deploy.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";

const SCOPE = "test-scope";

function makeDeps(overrides: Partial<StudioDeployDeps> = {}): StudioDeployDeps {
  return {
    store: createTestStore(),
    slots: createSlotCache(),
    storage: createTestStorage(),
    bundle: async () => "export default {};",
    inspect: async () => TEST_AGENT_CONFIG,
    ...overrides,
  };
}

async function seedProject(deps: StudioDeployDeps, project: string, deployedSlug?: string) {
  await putWorkspace(deps.storage, SCOPE, project, {
    files: { "agent.ts": "export default {}" },
    ...(deployedSlug && { deployedSlug }),
  });
}

describe("deployStudioProject", () => {
  test("bundles, inspects, deploys, and records the slug", async () => {
    const deps = makeDeps();
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "my-agent",
    });
    expect(result).toEqual({ ok: true, slug: "my-agent", url: "/my-agent/" });
    expect(await deps.store.getWorkerCode("my-agent")).toBe("export default {};");
    expect(await deps.store.getAgentConfig("my-agent")).toMatchObject({ name: "test-agent" });
    const ws = await getWorkspace(deps.storage, SCOPE, "my-agent");
    expect(ws?.deployedSlug).toBe("my-agent");
  });

  test("stores env secrets provided at deploy time", async () => {
    const deps = makeDeps();
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
      env: { ASSEMBLYAI_API_KEY: "aai-secret" },
    });
    expect(result.ok).toBe(true);
    expect(await deps.store.getEnv("p1")).toEqual({ ASSEMBLYAI_API_KEY: "aai-secret" });
  });

  test("redeploys reuse the recorded slug", async () => {
    const deps = makeDeps();
    await seedProject(deps, "p1", "older-slug");
    // Claim older-slug with the caller's own credential so redeploy passes
    // the ownership check the way a real first deploy would have set it up.
    await deps.store.putAgent({
      slug: "older-slug",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({ ok: true, slug: "older-slug" });
  });

  test("returns an error for a missing project", async () => {
    const deps = makeDeps();
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "ghost",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
  });

  test("surfaces build errors as messages (agent can self-correct)", async () => {
    const deps = makeDeps({
      bundle: async () => {
        throw new StudioBuildError("Build failed:\nagent.ts:1: oops");
      },
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("oops") });
  });

  test("uses the real esbuild bundler by default (build error, no sandbox needed)", async () => {
    const { bundle: _omit, ...deps } = makeDeps(); // fall through to bundleWorkspace
    await putWorkspace(deps.storage, SCOPE, "broken", {
      files: { "agent.ts": "const nope = {" },
    });
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "broken",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Build failed") });
  }, 30_000);

  test("surfaces sandbox load failures as messages", async () => {
    const deps = makeDeps({
      inspect: async () => {
        throw new Error("bundle/load timed out");
      },
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("failed to load"),
    });
  });

  test("rejects a config that fails IsolateConfigSchema", async () => {
    const deps = makeDeps({ inspect: async () => ({ notAConfig: true }) });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid agent config"),
    });
  });

  test("a project named after a reserved slug cannot claim it", async () => {
    const deps = makeDeps();
    await seedProject(deps, "studio");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "studio",
    });
    expect(result).toMatchObject({ ok: false, error: "Reserved slug" });
  });

  test("cannot overwrite a slug owned by another key", async () => {
    const deps = makeDeps();
    await seedProject(deps, "taken");
    // Simulate another owner: a stored hash that never matches our key.
    await deps.store.putAgent({
      slug: "taken",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: ["pbkdf2:600000:AAAA:BBBB"],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "taken",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Forbidden") });
  });
});
