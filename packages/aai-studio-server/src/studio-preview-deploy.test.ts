// Copyright 2026 the AAI authors. MIT license.
/**
 * The preview deploy loop: what a settled edit deploys, what it stamps, and
 * how the durable queue behaves when it or the deploy fails.
 *
 * Split from `studio-preview.test.ts`, which covers the "landing on a project"
 * half (slug, warm-up, wake).
 */

import { describe, expect, test, vi } from "vitest";
import {
  makeStore,
  PROJECT,
  previewLogs,
  previewStamped,
  SCOPE,
  seededStore,
  settled,
  stampProject,
  TARGET,
} from "./_studio-preview-test-utils.ts";
import { createPreviewDeployer, type PreviewDeployerOptions } from "./studio-preview.ts";
import {
  createMemoryPreviewQueue,
  PREVIEW_JOB_MAX_ATTEMPTS,
  PREVIEW_JOB_VISIBILITY_MS,
} from "./studio-preview-queue.ts";
import type { WorkspaceDeployOutcome, WorkspaceDeployTarget } from "./studio-session-broker.ts";
import { getWorkspace } from "./studio-workspace.ts";

/** Jump the memory queue's clock past any visibility timeout. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A deployer over a fresh in-memory queue, with the periodic drain disabled —
 * scheduling kicks a drain synchronously, so the timer would only add
 * nondeterminism to these tests.
 */
function makeDeployer(opts: Omit<PreviewDeployerOptions, "queue" | "pollMs">) {
  const queue = createMemoryPreviewQueue();
  const deployer = createPreviewDeployer({ ...opts, queue, pollMs: 0 });
  return Object.assign(deployer, { queue });
}

describe("createPreviewDeployer", () => {
  const logs = previewLogs();

  test("deploys the workspace to the preview slug and stamps the metadata", async () => {
    const workspaces = await seededStore();
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "Deployed" }),
    );
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    const workspace = await previewStamped(workspaces);

    expect(deploy).toHaveBeenCalledWith(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      {
        serverUrl: TARGET.serverUrl,
        apiKey: TARGET.apiKey,
        slug: "contact-form-x7k2mq-preview",
        // The auto-preview deploy is the ONLY caller allowed to claim the
        // reserved `-preview` suffix, and it says so explicitly — Publish
        // shares this path and must not inherit the opt-in.
        allowPreviewSlug: true,
      },
    );
    expect(workspace.previewSlug).toBe("contact-form-x7k2mq-preview");
    expect(workspace.previewError).toBeUndefined();
    // The stamped hash matches the deployed files — the preview is current.
    expect(workspace.previewHash).toBe(workspace.hash);
  });

  test("prefers the slug the deploy actually claimed, and reuses it after", async () => {
    const workspaces = await seededStore();
    const deploy = vi.fn(
      async (
        _scope: string,
        _project: string,
        _files: Record<string, string>,
        _target: WorkspaceDeployTarget,
      ): Promise<WorkspaceDeployOutcome> => ({ ok: true, slug: "claimed", output: "ok" }),
    );
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewSlug).toBe("claimed");
    });

    // Edit → redeploys to the SAME slug, so the preview URL never rots.
    await stampProject(workspaces, { files: { "agent.ts": "// v2" } });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalledTimes(2));
    expect(deploy.mock.calls[1]?.[3]).toMatchObject({ slug: "claimed" });
  });

  test("a no-op schedule (preview already current) never deploys", async () => {
    const workspaces = await seededStore();
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await previewStamped(workspaces);
    // Same files, second schedule: nothing to ship.
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await settled();
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  test("schedules during a deploy coalesce into one trailing re-deploy", async () => {
    const workspaces = await seededStore();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalledTimes(1));
    // Three edits land while the first deploy is in flight…
    for (const version of ["v2", "v3", "v4"]) {
      await stampProject(workspaces, { files: { "agent.ts": `// ${version}` } });
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
    const workspaces = await seededStore({ "agent.ts": "// broken" });
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> => ({
        ok: false,
        output: "Build failed:\nagent.ts:1: oops",
      }),
    );
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

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
  });

  test("a success after a failure clears previewError", async () => {
    const workspaces = await seededStore({ "agent.ts": "// broken" });
    let ok = false;
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> =>
        ok ? { ok: true, output: "Deployed" } : { ok: false, output: "Build failed" },
    );
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewError).toBeDefined();
    });

    ok = true;
    await stampProject(workspaces, { files: { "agent.ts": "// fixed" } });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    expect((await previewStamped(workspaces)).previewError).toBeUndefined();
  });

  /**
   * The banner that could never clear. A bad edit fails its deploy and stamps
   * `previewError` while `previewHash` still names the last GOOD deploy; the
   * user reverts, the files hash returns to that value — and the no-op early
   * return fired before anything was stamped, so the pane showed a build error
   * for code no longer in the workspace, permanently, with every later job for
   * that project confirming it. Clearing on the no-op is the one case where
   * "success" needs no deploy: what is running already IS the current files.
   */
  test("a job over already-deployed files clears a stale previewError without deploying", async () => {
    const workspaces = await seededStore({ "agent.ts": "// good" });
    let ok = true;
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> =>
        ok ? { ok: true, output: "Deployed" } : { ok: false, output: "Build failed" },
    );
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });

    // A good deploy, then a bad edit that fails.
    deployer.schedule(SCOPE, PROJECT, TARGET);
    const goodHash = (await previewStamped(workspaces)).previewHash;
    ok = false;
    await stampProject(workspaces, { files: { "agent.ts": "// broken" } });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewError).toBeDefined();
    });
    expect(deploy).toHaveBeenCalledTimes(2);

    // Undo. The files now hash to exactly what is deployed.
    await stampProject(workspaces, { files: { "agent.ts": "// good" } });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(async () => {
      expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewError).toBeUndefined();
    });

    const after = await getWorkspace(workspaces, SCOPE, PROJECT);
    // Nothing was redeployed — the running preview is already these files.
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(after?.previewHash).toBe(goodHash);
  });

  test("a no-op job over a clean workspace stamps nothing at all", async () => {
    // The common case, and the one the clear above must not turn into a write:
    // N queued jobs for one project cost a read each, not a version bump each
    // (every bump is an SSE push of the whole file map to every open tab).
    const workspaces = await seededStore();
    const deploy = vi.fn(
      async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "Deployed" }),
    );
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    const before = await previewStamped(workspaces);

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await settled();

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(await getWorkspace(workspaces, SCOPE, PROJECT)).toEqual(before);
  });

  test("a deleted project deploys nothing and never resurrects", async () => {
    const workspaces = makeStore();
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });
    deployer.schedule(SCOPE, "ghost", TARGET);
    await settled();
    expect(deploy).not.toHaveBeenCalled();
    expect(await getWorkspace(workspaces, SCOPE, "ghost")).toBeNull();
  });

  test("a thrown deploy (dead sandbox) is contained, not fatal", async () => {
    const workspaces = await seededStore();
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => {
      throw new Error("sandbox gone");
    });
    const deployer = makeDeployer({ workspaces, deployWorkspace: deploy });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(logs.warns().length).toBeGreaterThan(0));
    // A later schedule runs again — nothing wedged.
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(deploy).toHaveBeenCalledTimes(2));
  });

  /**
   * The whole point of the queue. Before it, a deploy that died mid-flight
   * (replica restart, sandbox gone) was simply lost, and the workspace sat
   * stamped-stale with nothing on the way — the pane showing "Updating
   * preview…" indefinitely.
   */
  test("a job whose deploy throws is left for redelivery, not consumed", async () => {
    const workspaces = await seededStore();
    let attempts = 0;
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => {
      attempts++;
      if (attempts === 1) throw new Error("sandbox gone");
      return { ok: true, output: "Deployed" };
    });
    const queue = createMemoryPreviewQueue({ now: () => Date.now() + attempts * DAY_MS });
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: deploy,
      queue,
      pollMs: 0,
    });

    deployer.schedule(SCOPE, PROJECT, TARGET);
    await vi.waitFor(() => expect(logs.warns().length).toBeGreaterThan(0));
    // Not acked and not archived: still in the queue, merely invisible.
    expect(queue.archived).toEqual([]);

    // The next drain — any replica's — picks it up and finishes the work.
    await deployer.drainOnce();
    expect((await previewStamped(workspaces)).previewError).toBeUndefined();
  });

  test("a job wedged on its project lock is handed back, not sat on", async () => {
    // A claimed job is invisible to the whole fleet for the visibility
    // timeout, so waiting on an in-process lock spends the queue's own
    // durability. The acquire is bounded well under that window; a lapsed one
    // rejects, leaving the job unacked for redelivery.
    vi.useFakeTimers();
    try {
      const workspaces = await seededStore();

      // The first deploy never returns — a sandbox that went away mid-request.
      const wedged = vi.fn(
        (): Promise<WorkspaceDeployOutcome> =>
          new Promise(() => {
            /* never settles */
          }),
      );
      const queue = createMemoryPreviewQueue();
      const deployer = createPreviewDeployer({
        workspaces,
        deployWorkspace: wedged,
        queue,
        pollMs: 0,
        resolveApiKey: () => Promise.resolve("stored-key"),
      });

      // Two jobs for ONE project, so the batch claims both and the second
      // queues behind the first on the project lock.
      const job = { scope: SCOPE, project: PROJECT, serverUrl: TARGET.serverUrl, userId: "u1" };
      await queue.enqueue(job);
      await queue.enqueue(job);

      // Never settles — the first job's deploy is wedged by construction.
      void deployer.drainOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(wedged).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(PREVIEW_JOB_VISIBILITY_MS);

      // The waiter gave up rather than holding its claim to the deadline, and
      // it is still in the queue — unacked and unarchived — for redelivery.
      // Asserting the REASON, not just that something warned: a job left
      // unacked because the deploy errored looks identical from the queue's
      // side, and only the message separates it from the lock lapsing.
      expect(logs.all()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          msg: "studio.preview deploy errored",
          ctx: expect.objectContaining({ error: expect.stringContaining("timed out") }),
        }),
      );
      expect(queue.archived).toEqual([]);
      expect(wedged).toHaveBeenCalledTimes(1);
      deployer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a job redelivered past the attempt cap is archived, not retried forever", async () => {
    const workspaces = await seededStore();
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => {
      throw new Error("crash loop");
    });
    let reads = 0;
    const queue = createMemoryPreviewQueue({ now: () => Date.now() + ++reads * DAY_MS });
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: deploy,
      queue,
      pollMs: 0,
    });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    for (let i = 0; i < PREVIEW_JOB_MAX_ATTEMPTS + 2; i++) await deployer.drainOnce();
    expect(queue.archived).toHaveLength(1);
    // Capped: the deploy is not attempted once per drain forever.
    expect(deploy.mock.calls.length).toBeLessThanOrEqual(PREVIEW_JOB_MAX_ATTEMPTS);
  });

  /**
   * A durable row must never carry a credential, so a job redelivered to a
   * replica that did not enqueue it resolves the user's key from Vault.
   */
  test("a redelivered job resolves the caller's key by user id", async () => {
    const workspaces = await seededStore();
    const queue = createMemoryPreviewQueue();
    // Enqueued by a replica that is now gone: only the row survives.
    await queue.enqueue({
      scope: SCOPE,
      project: PROJECT,
      serverUrl: TARGET.serverUrl,
      userId: "user-1",
    });
    const targets: WorkspaceDeployTarget[] = [];
    const deploy = vi.fn(
      async (
        _scope: string,
        _project: string,
        _files: Record<string, string>,
        target: WorkspaceDeployTarget,
      ): Promise<WorkspaceDeployOutcome> => {
        targets.push(target);
        return { ok: true, output: "ok" };
      },
    );
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: deploy,
      queue,
      pollMs: 0,
      resolveApiKey: (userId) => Promise.resolve(userId === "user-1" ? "stored-key" : null),
    });
    await deployer.drainOnce();
    expect(targets[0]).toMatchObject({ apiKey: "stored-key" });
  });

  test("a redelivered job with no resolvable key is archived", async () => {
    const workspaces = await seededStore();
    const queue = createMemoryPreviewQueue();
    // No userId: a raw-key caller's job whose enqueuing replica is gone. No
    // replica will ever hold that credential, so retrying is pointless.
    await queue.enqueue({ scope: SCOPE, project: PROJECT, serverUrl: TARGET.serverUrl });
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: deploy,
      queue,
      pollMs: 0,
    });
    await deployer.drainOnce();
    expect(deploy).not.toHaveBeenCalled();
    expect(queue.archived).toHaveLength(1);
  });
});

/**
 * The queue is best-effort by design: preview scheduling must never fail a
 * caller's request, and a queue read that fails must not wedge the drain. Both
 * guarantees are pure error handling, so nothing else in this file reaches
 * them — and a swallowed error is exactly the kind of code that rots unnoticed.
 */
describe("queue failures are contained", () => {
  const logs = previewLogs();

  test("an enqueue failure is logged and never reaches the caller", async () => {
    const workspaces = await seededStore();
    const queue = createMemoryPreviewQueue();
    queue.enqueue = () => Promise.reject(new Error("pgmq is down"));
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }),
      queue,
      pollMs: 0,
    });

    // `schedule` is fire-and-forget from an editor PUT or an agent turn: a
    // throw here would surface as a failed file write.
    expect(() => deployer.schedule(SCOPE, PROJECT, TARGET)).not.toThrow();
    await settled();
    expect(logs.warns()).toContain("studio.preview queue enqueue failed");
  });

  test("a claim failure yields no jobs rather than throwing", async () => {
    const workspaces = makeStore();
    const queue = createMemoryPreviewQueue();
    queue.claim = () => Promise.reject(new Error("connection reset"));
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: deploy,
      queue,
      pollMs: 0,
    });

    // The drain runs on a timer and on every edit; a rejection would become an
    // unhandled one, and the next tick has to keep working regardless.
    await expect(deployer.drainOnce()).resolves.toBeUndefined();
    expect(deploy).not.toHaveBeenCalled();
  });

  test("an ack failure is logged, leaving the job for redelivery", async () => {
    const workspaces = await seededStore();
    const queue = createMemoryPreviewQueue();
    queue.ack = () => Promise.reject(new Error("ack lost"));
    const deploy = vi.fn(async (): Promise<WorkspaceDeployOutcome> => ({ ok: true, output: "ok" }));
    const deployer = createPreviewDeployer({
      workspaces,
      deployWorkspace: deploy,
      queue,
      pollMs: 0,
    });
    deployer.schedule(SCOPE, PROJECT, TARGET);
    await settled();

    // The deploy still happened and was still stamped — an unacked job is
    // redelivered and then no-ops on the matching hash, which is the whole
    // reason at-least-once is safe here.
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(logs.warns()).toContain("studio.preview queue ack failed");
  });
});
