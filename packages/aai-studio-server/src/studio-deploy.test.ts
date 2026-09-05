// Copyright 2025 the AAI authors. MIT license.
// deployStudioProject is thin now: the guest sandbox runs the literal
// `aai deploy` (broker.deployWorkspace), so ownership, reserved slugs, env
// seeding, and the credential preflight are the PLATFORM deploy path's job
// (tested in aai-server). What's left here: target construction, deploy
// metadata stamping, and passing the CLI's output through for the chat.

import { createMemoryWorkspaceStore } from "aai-server/stores";
import { describe, expect, test, vi } from "vitest";
import { deployStudioProject, type StudioDeployDeps } from "./studio-deploy.ts";
import type { WorkspaceDeployOutcome } from "./studio-session-broker.ts";
import {
  createWorkspace,
  deleteWorkspace,
  filesHash,
  getWorkspace,
  hasUnpublishedChanges,
  mutateWorkspace,
} from "./studio-workspace.ts";

const SCOPE = "test-scope";

function fakeDeployWorkspace(
  overrides: Partial<WorkspaceDeployOutcome> = {},
): StudioDeployDeps["deployWorkspace"] {
  return async () => ({
    ok: true,
    slug: "my-agent",
    url: "https://platform.example/my-agent",
    output: "Deployed https://platform.example/my-agent\nslug: my-agent",
    ...overrides,
  });
}

function makeDeps(overrides: Partial<StudioDeployDeps> = {}): StudioDeployDeps {
  return {
    workspaces: createMemoryWorkspaceStore(),
    deployWorkspace: fakeDeployWorkspace(),
    ...overrides,
  };
}

const PARAMS = {
  apiKey: "caller-key",
  scope: SCOPE,
  project: "my-agent",
  serverUrl: "https://platform.example",
  // Equal to `serverUrl` on every backend but the local microVM one; the case
  // where they differ has its own test below.
  browserUrl: "https://platform.example",
};

async function seedProject(deps: StudioDeployDeps, project: string, deployedSlug?: string) {
  await createWorkspace(deps.workspaces, SCOPE, project, {
    files: { "agent.ts": "export default {}" },
    ...(deployedSlug && { deployedSlug }),
  });
}

describe("deployStudioProject", () => {
  test("hands the sandbox the files, platform origin, caller key, and slug", async () => {
    const deployWorkspace = vi.fn(fakeDeployWorkspace());
    const deps = makeDeps({ deployWorkspace });
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, PARAMS);
    expect(result).toMatchObject({ ok: true, slug: "my-agent", url: "/my-agent/" });
    expect(deployWorkspace).toHaveBeenCalledWith(
      SCOPE,
      "my-agent",
      { "agent.ts": "export default {}" },
      {
        serverUrl: "https://platform.example",
        apiKey: "caller-key",
        // First deploys claim the project name itself.
        slug: "my-agent",
      },
    );
  });

  test("forwards skipTypecheck to the sandbox, and omits it by default", async () => {
    const off = vi.fn(fakeDeployWorkspace());
    const offDeps = makeDeps({ deployWorkspace: off });
    await seedProject(offDeps, "my-agent");
    await deployStudioProject(offDeps, PARAMS);
    // Undefined by default so the in-sandbox `aai deploy` runs its tsc gate.
    expect(off.mock.calls[0]?.[3]?.skipTypecheck).toBeUndefined();

    const on = vi.fn(fakeDeployWorkspace());
    const onDeps = makeDeps({ deployWorkspace: on });
    await seedProject(onDeps, "my-agent");
    await deployStudioProject(onDeps, { ...PARAMS, skipTypecheck: true });
    expect(on.mock.calls[0]?.[3]).toMatchObject({ skipTypecheck: true });
  });

  test("passes the CLI output through for the chat", async () => {
    const deps = makeDeps();
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, PARAMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain("Deployed https://platform.example/my-agent");
  });

  test("records the deployed slug and hash on success", async () => {
    const deps = makeDeps();
    await seedProject(deps, "my-agent");
    const before = await getWorkspace(deps.workspaces, SCOPE, "my-agent");
    await deployStudioProject(deps, PARAMS);
    const ws = await getWorkspace(deps.workspaces, SCOPE, "my-agent");
    expect(ws?.deployedSlug).toBe("my-agent");
    expect(ws?.deployedHash).toBe(before?.hash);
    expect(ws?.deployedHash).toBe(filesHash(before?.files ?? {}));
  });

  test("redeploys target the recorded slug", async () => {
    const deployWorkspace = vi.fn(fakeDeployWorkspace({ slug: "older-slug" }));
    const deps = makeDeps({ deployWorkspace });
    await seedProject(deps, "my-agent", "older-slug");
    const result = await deployStudioProject(deps, PARAMS);
    expect(result).toMatchObject({ ok: true, slug: "older-slug" });
    expect(deployWorkspace).toHaveBeenCalledWith(
      SCOPE,
      "my-agent",
      expect.anything(),
      expect.objectContaining({ slug: "older-slug" }),
    );
  });

  test("a failed deploy returns the CLI's diagnostics as the error", async () => {
    const deps = makeDeps({
      deployWorkspace: async () => ({
        ok: false,
        output: "Build failed:\nagent.ts:1: oops",
      }),
    });
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, PARAMS);
    expect(result).toEqual({ ok: false, error: "Build failed:\nagent.ts:1: oops" });
    // No metadata stamped for a failed publish.
    const ws = await getWorkspace(deps.workspaces, SCOPE, "my-agent");
    expect(ws?.deployedSlug).toBeUndefined();
  });

  // The guest is handed an origin it can DIAL, which under the microVM backend
  // is a name resolvable only inside a VM — and the CLI prints it into the one
  // place a publish reports itself. Measured before the fix: `Deployed
  // http://host.microsandbox.internal:8080/my-agent` in the Publish menu.
  const GUEST_ORIGIN = "http://host.microsandbox.internal:8080";
  const VM_PARAMS = { ...PARAMS, serverUrl: GUEST_ORIGIN };

  test("translates the guest-dialable origin back to the browser's", async () => {
    const deps = makeDeps({
      deployWorkspace: fakeDeployWorkspace({
        output: `Deployed ${GUEST_ORIGIN}/my-agent\nslug: my-agent`,
      }),
    });
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, VM_PARAMS);
    expect(result).toMatchObject({
      ok: true,
      output: "Deployed https://platform.example/my-agent\nslug: my-agent",
    });
  });

  test("translates it in a FAILURE too — an error names the origin it could not reach", async () => {
    const deps = makeDeps({
      deployWorkspace: async () => ({
        ok: false,
        output: `deploy failed: could not reach ${GUEST_ORIGIN}/deploy`,
      }),
    });
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, VM_PARAMS);
    expect(result).toEqual({
      ok: false,
      error: "deploy failed: could not reach https://platform.example/deploy",
    });
  });

  test("leaves output untouched when the two origins agree", async () => {
    const deps = makeDeps();
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, PARAMS);
    expect(result).toMatchObject({
      output: "Deployed https://platform.example/my-agent\nslug: my-agent",
    });
  });

  test("does not revert files written during the deploy", async () => {
    const deps = makeDeps();
    deps.deployWorkspace = async (scope, project) => {
      await mutateWorkspace(deps.workspaces, scope, project, (ws) => ({
        ...ws,
        files: { "agent.ts": "export default {}", "mid-deploy.ts": "added while deploying" },
      }));
      return { ok: true, slug: "my-agent", url: "u", output: "Deployed u" };
    };
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, PARAMS);
    expect(result).toMatchObject({ ok: true, slug: "my-agent" });
    const ws = await getWorkspace(deps.workspaces, SCOPE, "my-agent");
    expect(ws?.files["mid-deploy.ts"]).toBe("added while deploying");
    // The hash is of the snapshot actually deployed, so the mid-deploy edit
    // correctly reads as unpublished.
    expect(ws && hasUnpublishedChanges(ws)).toBe(true);
  });

  test("a project deleted during the deploy is not resurrected", async () => {
    const deps = makeDeps();
    deps.deployWorkspace = async (scope, project) => {
      await deleteWorkspace(deps.workspaces, scope, project);
      return { ok: true, slug: "my-agent", url: "u", output: "Deployed u" };
    };
    await seedProject(deps, "my-agent");
    const result = await deployStudioProject(deps, PARAMS);
    // The agent still deployed — only the workspace metadata write is skipped.
    expect(result).toMatchObject({ ok: true, slug: "my-agent" });
    expect(await getWorkspace(deps.workspaces, SCOPE, "my-agent")).toBeNull();
  });

  test("returns an error for a missing project", async () => {
    const deps = makeDeps();
    const result = await deployStudioProject(deps, { ...PARAMS, project: "ghost" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
  });
});
