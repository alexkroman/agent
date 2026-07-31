// Copyright 2025 the AAI authors. MIT license.

import { createSlotCache } from "aai-server/sandbox-slots";
import { hashApiKey } from "aai-server/secrets";
import { createTestStore, TEST_AGENT_CONFIG } from "aai-server/test-utils";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearStudioBuildCache, putCachedBuild } from "./studio-build-cache.ts";
import type { StudioBuildRequest, StudioBuildResult } from "./studio-build-protocol.ts";
import { StudioBuildError } from "./studio-bundle.ts";
import { deployStudioProject, type StudioDeployDeps } from "./studio-deploy.ts";
import {
  createWorkspace,
  deleteWorkspace,
  filesHash,
  getWorkspace,
  hasUnpublishedChanges,
  mutateWorkspace,
} from "./studio-workspace.ts";

const SCOPE = "test-scope";

// The build cache is process-wide and content-hash keyed; tests here reuse
// identical file contents with different injected bundlers, so isolate them.
beforeEach(() => {
  clearStudioBuildCache();
});

/**
 * Fake build runner honoring the runner contract: each artifact is present
 * iff the request asked for it. Per-target bodies are overridable.
 */
function fakeBuild(overrides: {
  worker?: () => Promise<string>;
  client?: () => Promise<Record<string, string>>;
}): (req: StudioBuildRequest) => Promise<StudioBuildResult> {
  const worker = overrides.worker ?? (async () => "export default {};");
  const client = overrides.client ?? (async (): Promise<Record<string, string>> => ({}));
  return async (req) => ({
    ...(req.worker && { worker: await worker() }),
    ...(req.client && { clientFiles: await client() }),
  });
}

function makeDeps(overrides: Partial<StudioDeployDeps> = {}): StudioDeployDeps {
  return {
    store: createTestStore(),
    slots: createSlotCache(),
    workspaces: createMemoryWorkspaceStore(),
    build: fakeBuild({}),
    inspect: async () => TEST_AGENT_CONFIG,
    ...overrides,
  };
}

async function seedProject(deps: StudioDeployDeps, project: string, deployedSlug?: string) {
  await createWorkspace(deps.workspaces, SCOPE, project, {
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
    const ws = await getWorkspace(deps.workspaces, SCOPE, "my-agent");
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

  test("ships the built client.tsx as the agent's clientFiles", async () => {
    const built = { "index.html": "<html>custom</html>", "assets/index-abc.js": "//js" };
    const deps = makeDeps({ build: fakeBuild({ client: async () => built }) });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result.ok).toBe(true);
    expect(await deps.store.getClientFile("p1", "index.html")).toBe("<html>custom</html>");
    expect(await deps.store.getClientFile("p1", "assets/index-abc.js")).toBe("//js");
  });

  test("a workspace with no client.tsx deploys no clientFiles (default UI)", async () => {
    const deps = makeDeps({ build: fakeBuild({ client: async () => ({}) }) });
    await seedProject(deps, "p1");
    await deployStudioProject(deps, { apiKey: "key1", scope: SCOPE, project: "p1" });
    expect(await deps.store.getClientFile("p1", "index.html")).toBeNull();
  });

  test("surfaces client build errors as messages (agent can self-correct)", async () => {
    const deps = makeDeps({
      build: fakeBuild({
        client: async () => {
          throw new StudioBuildError("Client build failed:\nclient.tsx:3: oops");
        },
      }),
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("oops") });
  });

  test("seeds the caller's API key as the agent's ASSEMBLYAI_API_KEY", async () => {
    // Studio has no secrets UI: without this, a published agent's env is empty
    // and its S2S connect sends `Bearer ` — AssemblyAI answers `unauthorized`.
    const deps = makeDeps();
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "caller-key",
      scope: SCOPE,
      project: "p1",
    });
    expect(result.ok).toBe(true);
    expect(await deps.store.getEnv("p1")).toEqual({ ASSEMBLYAI_API_KEY: "caller-key" });
  });

  test("an explicit deploy-time key overrides the caller's key", async () => {
    const deps = makeDeps();
    await seedProject(deps, "p1");
    await deployStudioProject(deps, {
      apiKey: "caller-key",
      scope: SCOPE,
      project: "p1",
      env: { ASSEMBLYAI_API_KEY: "explicit" },
    });
    expect(await deps.store.getEnv("p1")).toEqual({ ASSEMBLYAI_API_KEY: "explicit" });
  });

  test("a key already stored on the agent survives a redeploy", async () => {
    const deps = makeDeps();
    await seedProject(deps, "p1");
    await deployStudioProject(deps, {
      apiKey: "caller-key",
      scope: SCOPE,
      project: "p1",
      env: { ASSEMBLYAI_API_KEY: "set-via-secret-put" },
    });
    await deployStudioProject(deps, { apiKey: "caller-key", scope: SCOPE, project: "p1" });
    expect(await deps.store.getEnv("p1")).toEqual({ ASSEMBLYAI_API_KEY: "set-via-secret-put" });
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

  test("does not revert files written during the build", async () => {
    const deps = makeDeps();
    // Simulate an edit landing while the multi-second build runs: the final
    // metadata write must merge onto the current files, not the snapshot.
    deps.build = fakeBuild({
      worker: async () => {
        await mutateWorkspace(deps.workspaces, SCOPE, "p1", (ws) => ({
          ...ws,
          files: { "agent.ts": "export default {}", "mid-build.ts": "added while building" },
        }));
        return "export default {};";
      },
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({ ok: true, slug: "p1" });
    const ws = await getWorkspace(deps.workspaces, SCOPE, "p1");
    expect(ws?.files["mid-build.ts"]).toBe("added while building");
    expect(ws?.deployedSlug).toBe("p1");
    // The hash is of the snapshot actually built, so the mid-build edit
    // correctly reads as unpublished.
    expect(ws && hasUnpublishedChanges(ws)).toBe(true);
  });

  test("a project deleted during the build is not resurrected", async () => {
    const deps = makeDeps();
    deps.build = fakeBuild({
      worker: async () => {
        await deleteWorkspace(deps.workspaces, SCOPE, "p1");
        return "export default {};";
      },
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    // The agent still deployed — only the workspace metadata write is skipped.
    expect(result).toMatchObject({ ok: true, slug: "p1" });
    expect(await getWorkspace(deps.workspaces, SCOPE, "p1")).toBeNull();
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
      build: fakeBuild({
        worker: async () => {
          throw new StudioBuildError("Build failed:\nagent.ts:1: oops");
        },
      }),
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("oops") });
  });

  test("uses the real build subprocess by default (build error, no sandbox needed)", async () => {
    const { build: _omit, ...deps } = makeDeps(); // fall through to the env-selected runner
    await createWorkspace(deps.workspaces, SCOPE, "broken", {
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

  test("a repeat publish of unchanged files skips both builds", async () => {
    const build = vi.fn(fakeBuild({}));
    const deps = makeDeps({ build });
    await seedProject(deps, "p1");
    expect((await deployStudioProject(deps, { apiKey: "k", scope: SCOPE, project: "p1" })).ok).toBe(
      true,
    );
    expect((await deployStudioProject(deps, { apiKey: "k", scope: SCOPE, project: "p1" })).ok).toBe(
      true,
    );
    // Content-hash keyed cache: the second publish built nothing.
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ worker: true, client: true }));
  });

  test("a worker cached by test_agent leaves only the client build to publish", async () => {
    const build = vi.fn(
      fakeBuild({
        worker: async () => "should not run",
        client: async () => ({ "index.html": "<html>built</html>" }),
      }),
    );
    const deps = makeDeps({ build });
    await seedProject(deps, "p1");
    const workspace = await getWorkspace(deps.workspaces, SCOPE, "p1");
    // Simulate the chat turn's test_agent build of the same content.
    putCachedBuild(filesHash(workspace?.files ?? {}), { worker: "from-test-agent" });

    const result = await deployStudioProject(deps, { apiKey: "k", scope: SCOPE, project: "p1" });
    expect(result.ok).toBe(true);
    // One runner call, asked for the client half only.
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ worker: false, client: true }));
    expect(await deps.store.getWorkerCode("p1")).toBe("from-test-agent");
    expect(await deps.store.getClientFile("p1", "index.html")).toBe("<html>built</html>");
  });

  test("reuses the workspace's stored hash for deployedHash", async () => {
    const deps = makeDeps();
    await seedProject(deps, "p1");
    const before = await getWorkspace(deps.workspaces, SCOPE, "p1");
    expect(before?.hash).toBeDefined();
    await deployStudioProject(deps, { apiKey: "k", scope: SCOPE, project: "p1" });
    const after = await getWorkspace(deps.workspaces, SCOPE, "p1");
    expect(after?.deployedHash).toBe(before?.hash);
    expect(after?.deployedHash).toBe(filesHash(before?.files ?? {}));
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
      credential_hashes: [await hashApiKey("someone-elses-key")],
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
