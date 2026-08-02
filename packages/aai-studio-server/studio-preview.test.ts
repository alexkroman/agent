// Copyright 2026 the AAI authors. MIT license.

import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { createPreviewDeployer, previewSlugFor } from "./studio-preview.ts";
import type { WorkspaceDeployOutcome, WorkspaceDeployTarget } from "./studio-session-broker.ts";
import { createWorkspace, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope";
const PROJECT = "contact-form-x7k2mq";
const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key" };

function makeStore() {
  return createMemoryWorkspaceStore();
}

/** Wait for the fire-and-forget deploy loop to drain. */
async function settled() {
  await vi.waitFor(() => Promise.resolve());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("previewSlugFor", () => {
  test("appends -preview to the project name", () => {
    expect(previewSlugFor(PROJECT)).toBe("contact-form-x7k2mq-preview");
  });

  test("truncates so the result still fits the 64-char slug shape", () => {
    const long = `a${"b".repeat(70)}`;
    const slug = previewSlugFor(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-preview")).toBe(true);
    // Never a double separator at the truncation point.
    expect(slug).not.toContain("--preview");
  });

  test("trims trailing separators left by truncation", () => {
    expect(previewSlugFor(`${"x".repeat(55)}-tail`)).toBe(`${"x".repeat(55)}-preview`);
  });
});

describe("createPreviewDeployer", () => {
  test("deploys the workspace to the preview slug and stamps the metadata", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "Deployed" }),
    );
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewHash).toBeDefined();
    });

    expect(deploy).toHaveBeenCalledWith(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      {
        serverUrl: TARGET.serverUrl,
        apiKey: TARGET.apiKey,
        slug: "contact-form-x7k2mq-preview",
      },
    );
    const workspace = await getWorkspace(workspaces, SCOPE, PROJECT);
    expect(workspace?.previewSlug).toBe("contact-form-x7k2mq-preview");
    expect(workspace?.previewError).toBeUndefined();
    // The stamped hash matches the deployed files — the preview is current.
    expect(workspace?.previewHash).toBe(workspace?.hash);
  });

  test("prefers the slug the deploy actually claimed, and reuses it after", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    const deploy = vi.fn(
      async (
        _scope: string,
        _project: string,
        _files: Record<string, string>,
        _target: WorkspaceDeployTarget,
      ): Promise<WorkspaceDeployOutcome> => ({ ok: true, slug: "claimed", output: "ok" }),
    );
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewSlug).toBe("claimed");
    });

    // Edit → redeploys to the SAME slug, so the preview URL never rots.
    await mutateWorkspace(workspaces, SCOPE, PROJECT, (ws) => ({
      ...ws,
      files: { "agent.ts": "// v2" },
    }));
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalledTimes(2));
    expect(deploy.mock.calls[1]?.[3]).toMatchObject({ slug: "claimed" });
  });

  test("a no-op schedule (preview already current) never deploys", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewHash).toBeDefined();
    });
    // Same files, second schedule: nothing to ship.
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await settled();
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  test("schedules during a deploy coalesce into one trailing re-deploy", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deploy = vi.fn(
      async (
        _scope: string,
        _project: string,
        _files: Record<string, string>,
        _target: WorkspaceDeployTarget,
      ): Promise<WorkspaceDeployOutcome> => {
        await gate;
        return { ok: true, output: "ok" };
      },
    );
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalledTimes(1));
    // Three edits land while the first deploy is in flight…
    for (const version of ["v2", "v3", "v4"]) {
      await mutateWorkspace(workspaces, SCOPE, PROJECT, (ws) => ({
        ...ws,
        files: { "agent.ts": `// ${version}` },
      }));
      deployer.schedule(SCOPE, PROJECT, TARGET);
    }
    release();
    // …and cost exactly one trailing deploy, of the FINAL tree.
    await vi.waitFor(async () => {
      const workspace = await getWorkspace(workspaces, SCOPE, PROJECT);
      expect(workspace?.previewHash).toBe(workspace?.hash);
    });
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(deploy.mock.calls[1]?.[2]).toEqual({ "agent.ts": "// v4" });
  });

  test("a failed deploy stamps previewError and leaves the hash unset", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// broken" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> => ({
        ok: false,
        output: "Build failed:\nagent.ts:1: oops",
      }),
    );
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewError).toContain(
        "Build failed",
      );
    });
    const workspace = await getWorkspace(workspaces, SCOPE, PROJECT);
    // Still stale — the next edit retries.
    expect(workspace?.previewHash).toBeUndefined();
    expect(workspace?.previewSlug).toBeUndefined();
    warn.mockRestore();
  });

  test("a success after a failure clears previewError", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// broken" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let ok = false;
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> =>
        ok ? { ok: true, output: "Deployed" } : { ok: false, output: "Build failed" },
    );
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewError).toBeDefined();
    });

    ok = true;
    await mutateWorkspace(workspaces, SCOPE, PROJECT, (ws) => ({
      ...ws,
      files: { "agent.ts": "// fixed" },
    }));
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewHash).toBeDefined();
    });
    expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewError).toBeUndefined();
    warn.mockRestore();
  });

  test("a deleted project deploys nothing and never resurrects", async () => {
    const workspaces = makeStore();
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });
    deployer.schedule(SCOPE, "ghost", TARGET);
    await settled();
    expect(deploy).not.toHaveBeenCalled();
    expect(await getWorkspace(workspaces, SCOPE, "ghost")).toBeNull();
  });

  test("a thrown deploy (dead sandbox) is contained, not fatal", async () => {
    const workspaces = makeStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => {
      throw new Error("sandbox gone");
    });
    const deployer = createPreviewDeployer({ workspaces, deployWorkspace: deploy });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    // A later schedule runs again — the in-flight entry was cleaned up.
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });
});
