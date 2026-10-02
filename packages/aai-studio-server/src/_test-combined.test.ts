// Copyright 2026 the AAI authors. MIT license.
// The combined-composition test double (_test-combined.ts): one fetch that
// dispatches by path like the real entry, over one set of shared stores.

import { createMemoryWorkspaceStore } from "aai-server/stores";
import { authHeaders } from "aai-server/test-utils";
import { describe, expect, test } from "vitest";
import { fakeBroker } from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";
import { getWorkspace, studioScope } from "./studio-workspace.ts";

// A push schedules a preview deploy through the session broker; faked, so
// none outlives the test trying to reach Modal.
const studioSessionBroker = () => fakeBroker();

/** `aai push`'s first push — the one create route that takes a name. */
function pushProject(fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  return fetch("/studio/projects/proj/source", {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ files: { "agent.ts": "// v1" } }),
  });
}

describe("createTestCombined", () => {
  test("a studio path reaches the studio app, over the orchestrator's stores", async () => {
    const harness = await createTestCombined({ studioSessionBroker });
    expect((await pushProject(harness.fetch)).status).toBe(201);
    // Written through the studio route, read back from the harness's own
    // store: the two apps share one, as they do in production.
    const workspace = await getWorkspace(harness.workspaces, studioScope("key1"), "proj");
    expect(workspace?.files).toEqual({ "agent.ts": "// v1" });
  });

  test("every other path reaches the agent orchestrator", async () => {
    const { fetch } = await createTestCombined();
    const health = await fetch("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  test("an absolute URL is dispatched by its pathname", async () => {
    const { fetch } = await createTestCombined();
    // The studio refuses an unauthenticated caller; the orchestrator has no
    // such route to refuse it on.
    expect((await fetch("http://combined.test/studio/projects")).status).toBe(401);
  });

  test("an overriding store is the one the studio routes write", async () => {
    const workspaces = createMemoryWorkspaceStore();
    const { fetch } = await createTestCombined({ workspaces, studioSessionBroker });
    expect((await pushProject(fetch)).status).toBe(201);
    expect(await getWorkspace(workspaces, studioScope("key1"), "proj")).not.toBeNull();
  });

  test("exposes the studio's shutdown, which is safe before any session", async () => {
    const { disposeStudio } = await createTestCombined();
    await expect(disposeStudio()).resolves.toBeUndefined();
  });
});
