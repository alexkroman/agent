// Copyright 2026 the AAI authors. MIT license.
/**
 * The standalone studio service (split deployment) — see studio-app.ts.
 * Deep studio-route behavior is covered by studio-routes.test.ts against the
 * combined orchestrator; these tests pin what the split adds: the surface
 * serves standalone, and mutations reach the agent service via the shared
 * slug-epoch store.
 */

import { createMemoryChatStore } from "aai-server/chat-store";
import { createMemorySlugEpochs } from "aai-server/platform-epoch";
import { createTestStore } from "aai-server/test-utils";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, it } from "vitest";
import { createStudioApp, type StudioAppOpts } from "./studio-app.ts";

function makeApp(overrides: Partial<StudioAppOpts> = {}) {
  const slugEpochs = createMemorySlugEpochs();
  const { app } = createStudioApp({
    store: createTestStore(),
    workspaces: createMemoryWorkspaceStore(),
    chats: createMemoryChatStore(),
    slugEpochs,
    ...overrides,
  });
  const fetch = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://studio.local${path}`, init));
  return { app, fetch, slugEpochs };
}

describe("createStudioApp", () => {
  it("serves the health check, and 503s while draining", async () => {
    const healthy = makeApp();
    expect((await healthy.fetch("/health")).status).toBe(200);

    const draining = makeApp({ isDraining: () => true });
    expect((await draining.fetch("/health")).status).toBe(503);
  });

  it("serves the studio API surface standalone", async () => {
    const { fetch } = makeApp();
    // /studio/status is unauthenticated and answers regardless of LLM config.
    const status = await fetch("/studio/status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ llm: expect.any(Boolean) });
  });

  it("scopes projects to the caller's bearer key", async () => {
    const { fetch } = makeApp();
    const created = await fetch("/studio/projects", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-project" }),
    });
    expect(created.status).toBe(201);

    const mine = await fetch("/studio/projects", {
      headers: { Authorization: "Bearer key1" },
    });
    await expect(mine.json()).resolves.toEqual({ projects: ["my-project"] });

    const theirs = await fetch("/studio/projects", {
      headers: { Authorization: "Bearer key2" },
    });
    await expect(theirs.json()).resolves.toEqual({ projects: [] });
  });

  it("has no agent surface: slug routes 404", async () => {
    const { fetch } = makeApp();
    expect((await fetch("/some-agent/health")).status).toBe(404);
    expect((await fetch("/some-agent/client-config")).status).toBe(404);
  });

  it("serves the root studio page", async () => {
    const { fetch } = makeApp();
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
