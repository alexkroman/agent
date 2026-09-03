// Copyright 2026 the AAI authors. MIT license.
/**
 * The "landing on a project" half of preview handling (studio-preview-wake.ts):
 * the sandbox warm-up, and the wake that hangs off the session broker call.
 *
 * The deploy loop and its durable queue live in
 * `studio-preview-deploy.test.ts`, and the preview slug's NAME in
 * `studio-project-slugs.test.ts` — the three share only a workspace, and
 * splitting them keeps each under the file-length cap.
 */

import { describe, expect, test, vi } from "vitest";
import { answering, fakeFetch } from "./_studio-fetch-test-utils.ts";
import {
  makeStore,
  PROJECT,
  SCOPE,
  seededStore,
  settled,
  stampProject,
  TARGET,
} from "./_studio-preview-test-utils.ts";
import { wakeProjectPreview, warmPreviewSandbox } from "./studio-preview-wake.ts";
import type { WorkspaceDeployTarget } from "./studio-session-broker.ts";
import { getWorkspace } from "./studio-workspace.ts";

describe("warmPreviewSandbox", () => {
  test("hits the platform's client-config broker for the slug, with a deadline", async () => {
    const fetchImpl = fakeFetch();
    await expect(
      warmPreviewSandbox("https://platform.example", "proj-preview", fetchImpl),
    ).resolves.toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://platform.example/proj-preview/client-config");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("reports the broker's status so callers can spot a gone agent", async () => {
    const fetchImpl = fakeFetch(answering("nope", 404));
    await expect(
      warmPreviewSandbox("https://platform.example", "proj-preview", fetchImpl),
    ).resolves.toBe(404);
  });

  test("resolves null on fetch failure — the warm-up is only an accelerator", async () => {
    const fetchImpl = fakeFetch(() => Promise.reject(new Error("cold boot timed out")));
    await expect(
      warmPreviewSandbox("https://platform.example", "proj-preview", fetchImpl),
    ).resolves.toBeNull();
  });

  test("an unparsable origin is a no-op, never a throw", async () => {
    const fetchImpl = fakeFetch();
    await expect(warmPreviewSandbox("not a url", "proj-preview", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("wakeProjectPreview", () => {
  const scheduleFn = () =>
    vi.fn<(scope: string, project: string, target: WorkspaceDeployTarget) => void>();
  const wake = (
    workspaces: ReturnType<typeof makeStore>,
    schedule: ReturnType<typeof scheduleFn>,
    fetchImpl: ReturnType<typeof fakeFetch>,
  ) =>
    wakeProjectPreview({
      workspaces,
      scope: SCOPE,
      project: PROJECT,
      target: TARGET,
      schedule,
      fetchImpl,
    });

  /**
   * The queue owns delivery now, so a stale preview means a job is still
   * enqueued and the drain will run it. Re-scheduling on project open would
   * be a second mechanism answering the same question — and the weaker one,
   * since it only fires when a human happens to look.
   */
  test("a stale preview only warms — the queue owns the redeploy", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, {
      previewSlug: "p-preview",
      previewHash: "stale",
    });
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    await settled();
    expect(schedule).not.toHaveBeenCalled();
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://platform.example/p-preview/client-config");
  });

  test("a current preview only warms — never redeploys", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, (current) => ({
      previewSlug: "p-preview",
      previewHash: current.hash,
    }));
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(schedule).not.toHaveBeenCalled();
  });

  test("an empty workspace (fresh project) neither deploys nor warms", async () => {
    const workspaces = await seededStore({});
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    wake(workspaces, schedule, fetchImpl);
    await settled();
    // Nothing deployable yet — the first agent turn owns the first preview.
    expect(schedule).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * A settled failure is the one case with no queued job behind it, so the
   * wake is the only thing that can retry it. Not retrying is what turned a
   * transient failure — a platform 500, a Storage blip — into a permanently
   * stuck error banner that only an edit could clear.
   */
  test("a stamped failure is retried on open, and still warms", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, {
      previewSlug: "p-preview",
      previewError: "deploy failed (HTTP 500): Internal server error",
    });
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    // The previous deploy's agent is what the pane embeds, so it is still
    // worth warming while the retry runs.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a stamped failure is retried even with no agent ever deployed", async () => {
    // A first-ever preview that failed has no previewSlug and no deployedSlug,
    // so there is nothing to warm — and the early `if (!slug) return` this
    // replaced meant such a project could never retry at all.
    const workspaces = await seededStore();
    await stampProject(workspaces, {
      previewError: "deploy failed (HTTP 500): Internal server error",
    });
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * The retry has to CLEAR the stamp as well as schedule, and for a long time
   * it only scheduled — which made it a no-op in the one state it exists to
   * rescue. A failed deploy leaves `previewHash` naming the last GOOD deploy;
   * revert the bad edit and the files hash back to that value, so the job the
   * retry enqueues finds a matching hash and returns. Every project open then
   * scheduled another no-op behind a banner that could not clear. The `gone`
   * branch three tests down always cleared; `forcePreviewRedeploy` is what
   * stops the two branches from disagreeing again.
   */
  test("a settled failure retry clears previewHash, so the deploy is not a no-op", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, (current) => ({
      previewSlug: "p-preview",
      // The workspace was reverted to exactly what is deployed.
      previewHash: current.hash,
      previewError: "deploy failed (HTTP 500): Internal server error",
    }));
    const schedule = scheduleFn();
    wake(workspaces, schedule, fakeFetch());
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    await settled();
    const after = await getWorkspace(workspaces, SCOPE, PROJECT);
    expect(after?.previewHash).toBeUndefined();
    // The slug survives — the redeploy re-claims it, so the pane's URL holds.
    expect(after?.previewSlug).toBe("p-preview");
  });

  test("a retry leaves previewError stamped for the pane's banner", async () => {
    // Cleared only by a deploy that SUCCEEDS (see `attempt`), so the pane
    // keeps showing the last real error instead of flickering to "starting".
    const workspaces = await seededStore();
    await stampProject(workspaces, {
      previewSlug: "p-preview",
      previewError: "deploy failed (HTTP 500): Internal server error",
    });
    const schedule = scheduleFn();
    wake(workspaces, schedule, fakeFetch());
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    await settled();
    const after = await getWorkspace(workspaces, SCOPE, PROJECT);
    expect(after?.previewError).toBe("deploy failed (HTTP 500): Internal server error");
  });

  test("falls back to warming the production agent for pre-preview projects", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, (current) => ({
      deployedSlug: "prod-slug",
      deployedHash: current.hash,
      previewError: "Build failed: nope",
    }));
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://platform.example/prod-slug/client-config");
  });

  test("a 404 from the broker regenerates a 'current' preview", async () => {
    // The agent behind the stamp is GONE (expired/swept/deleted) — the
    // workspace still says the preview is current, so without the warm-up's
    // existence check nothing would ever redeploy it.
    const workspaces = await seededStore();
    await stampProject(workspaces, (current) => ({
      previewSlug: "p-preview",
      previewHash: current.hash,
    }));
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch(answering("nope", 404));
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith(SCOPE, PROJECT, TARGET));
    const workspace = await getWorkspace(workspaces, SCOPE, PROJECT);
    // The stamp was a lie — cleared so the scheduled deploy doesn't no-op.
    expect(workspace?.previewHash).toBeUndefined();
    // The slug survives, so the redeploy re-claims the same preview URL.
    expect(workspace?.previewSlug).toBe("p-preview");
  });

  test("a 503 (sandbox mid-boot) does not redeploy a current preview", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, (current) => ({
      previewSlug: "p-preview",
      previewHash: current.hash,
    }));
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch(answering("retry shortly", 503));
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await settled();
    expect(schedule).not.toHaveBeenCalled();
    expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.previewHash).toBeDefined();
  });

  test("a 404 on an already-stale preview schedules exactly once", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, {
      previewSlug: "p-preview",
      previewHash: "stale",
    });
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch(answering("nope", 404));
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await settled();
    // The stale path already rescheduled; the 404 must not double up.
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test("a 404 plus a stamped failure schedules exactly once", async () => {
    const workspaces = await seededStore();
    await stampProject(workspaces, (current) => ({
      previewSlug: "p-preview",
      previewHash: current.hash,
      previewError: "deploy failed (HTTP 500): Internal server error",
    }));
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch(answering("nope", 404));
    wake(workspaces, schedule, fetchImpl);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    await settled();
    // Both reasons to redeploy are present; they must not double up.
    expect(schedule).toHaveBeenCalledTimes(1);
    // The 404 branch still drops the stamp, else the deploy no-ops on a hash
    // that matches a preview the platform no longer serves.
    const after = await getWorkspace(workspaces, SCOPE, PROJECT);
    expect(after?.previewHash).toBeUndefined();
  });

  test("a missing project is a silent no-op", async () => {
    const workspaces = makeStore();
    const schedule = scheduleFn();
    const fetchImpl = fakeFetch();
    expect(() => wake(workspaces, schedule, fetchImpl)).not.toThrow();
    await settled();
    expect(schedule).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("wakeProjectPreview containment", () => {
  test("a failing workspace read is swallowed — the wake is only an accelerator", async () => {
    // Hung off the once-per-open session broker call, whose response must not
    // depend on it. The pane's own iframe fetch remains the functional path.
    const workspaces = makeStore();
    workspaces.get = () => Promise.reject(new Error("database unreachable"));
    const schedule = vi.fn();
    expect(() =>
      wakeProjectPreview({
        workspaces,
        scope: SCOPE,
        project: PROJECT,
        target: TARGET,
        schedule,
        fetchImpl: () => Promise.reject(new Error("never asked")),
      }),
    ).not.toThrow();
    await settled();
    expect(schedule).not.toHaveBeenCalled();
  });
});
