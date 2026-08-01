// Copyright 2025 the AAI authors. MIT license.

import { createSlotCache } from "aai-server/sandbox-slots";
import { hashApiKey } from "aai-server/secrets";
import { createTestStore, TEST_AGENT_CONFIG } from "aai-server/test-utils";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { deployStudioProject, type StudioDeployDeps } from "./studio-deploy.ts";
import type { WorkspaceBuildOutcome } from "./studio-session-broker.ts";
import {
  createWorkspace,
  deleteWorkspace,
  filesHash,
  getWorkspace,
  hasUnpublishedChanges,
  mutateWorkspace,
} from "./studio-workspace.ts";

const SCOPE = "test-scope";

/**
 * Fake of the broker's in-sandbox `workspace/build`: artifacts plus the
 * config the guest extracted by loading the built worker in place.
 */
function fakeBuildWorkspace(
  overrides: Partial<Extract<WorkspaceBuildOutcome, { ok: true }>> = {},
): StudioDeployDeps["buildWorkspace"] {
  return async () => ({
    ok: true,
    worker: "export default {};",
    clientFiles: {},
    config: TEST_AGENT_CONFIG,
    ...overrides,
  });
}

function makeDeps(overrides: Partial<StudioDeployDeps> = {}): StudioDeployDeps {
  return {
    store: createTestStore(),
    slots: createSlotCache(),
    workspaces: createMemoryWorkspaceStore(),
    buildWorkspace: fakeBuildWorkspace(),
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
  test("builds in the sandbox, validates the config, deploys, records the slug", async () => {
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

  test("passes the workspace snapshot to the sandbox build", async () => {
    const buildWorkspace = vi.fn(fakeBuildWorkspace());
    const deps = makeDeps({ buildWorkspace });
    await seedProject(deps, "p1");
    await deployStudioProject(deps, { apiKey: "key1", scope: SCOPE, project: "p1" });
    expect(buildWorkspace).toHaveBeenCalledWith(SCOPE, "p1", {
      "agent.ts": "export default {}",
    });
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
    const deps = makeDeps({ buildWorkspace: fakeBuildWorkspace({ clientFiles: built }) });
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
    const deps = makeDeps({ buildWorkspace: fakeBuildWorkspace({ clientFiles: {} }) });
    await seedProject(deps, "p1");
    await deployStudioProject(deps, { apiKey: "key1", scope: SCOPE, project: "p1" });
    expect(await deps.store.getClientFile("p1", "index.html")).toBeNull();
  });

  test("surfaces build errors as messages (agent can self-correct)", async () => {
    const deps = makeDeps({
      buildWorkspace: async () => ({ ok: false, error: "Build failed:\nagent.ts:1: oops" }),
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("oops") });
  });

  test("surfaces sandbox load failures as messages", async () => {
    // The guest reports a worker that built but failed bundle/load as a
    // buildError (see aai-guest harness workspace/build).
    const deps = makeDeps({
      buildWorkspace: async () => ({
        ok: false,
        error: "Agent bundle failed to load: bundle/load timed out",
      }),
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
    const deps = makeDeps({ buildWorkspace: fakeBuildWorkspace({ config: { notAConfig: true } }) });
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

  test("rejects a build response that carries no config", async () => {
    const deps = makeDeps({ buildWorkspace: fakeBuildWorkspace({ config: undefined }) });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "key1",
      scope: SCOPE,
      project: "p1",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not self-describe"),
    });
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
    deps.buildWorkspace = async (scope, project) => {
      await mutateWorkspace(deps.workspaces, scope, project, (ws) => ({
        ...ws,
        files: { "agent.ts": "export default {}", "mid-build.ts": "added while building" },
      }));
      return { ok: true, worker: "export default {};", clientFiles: {}, config: TEST_AGENT_CONFIG };
    };
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
    deps.buildWorkspace = async (scope, project) => {
      await deleteWorkspace(deps.workspaces, scope, project);
      return { ok: true, worker: "export default {};", clientFiles: {}, config: TEST_AGENT_CONFIG };
    };
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

  test("a missing non-AssemblyAI credential publishes with a warning, not a failure", async () => {
    // The studio has no secrets UI, so the shared deploy core's credential
    // preflight must not hard-fail here — the warning rides to the client.
    const deps = makeDeps({
      inspect: async () => ({
        ...TEST_AGENT_CONFIG,
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "anthropic", options: { model: "claude-sonnet-4-5" } },
        tts: { kind: "cartesia", options: {} },
      }),
    });
    await seedProject(deps, "p1");
    const result = await deployStudioProject(deps, {
      apiKey: "caller-key",
      scope: SCOPE,
      project: "p1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toContain("ANTHROPIC_API_KEY");
      expect(result.warning).toContain("CARTESIA_API_KEY");
      // The seeded caller key satisfies the AssemblyAI stage.
      expect(result.warning).not.toContain("ASSEMBLYAI_API_KEY");
    }
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
