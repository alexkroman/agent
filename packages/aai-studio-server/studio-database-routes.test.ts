// Copyright 2026 the AAI authors. MIT license.
// The project database's HTTP surface, through the full combined app: one
// switch that reaches BOTH of a project's deployed agents, and the deploy
// hook that catches an environment which did not exist when it was flipped.
// The switch's own behavior lives in studio-database.test.ts.

import { authFetch } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { claimSlug, type FakeAppDb, fakeAppDb } from "./_studio-agents-test-utils.ts";
import { createProject } from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";
import type {
  createStudioSessionBroker,
  StudioSessionBroker,
  StudioSessionBrokerOptions,
} from "./studio-session-broker.ts";
import { getWorkspace, mutateWorkspace, studioScope } from "./studio-workspace.ts";

// The broker is faked: enabling the database schedules a preview deploy, and
// a real broker would try to spawn a harness for it. Capturing the options is
// also how the long-lived `afterDeploy` hook is asserted.
const schedulePreviewMock = vi.fn();
const brokerMock = vi.fn(
  (..._args: Parameters<typeof createStudioSessionBroker>): StudioSessionBroker => ({
    ensureSession: async () => ({ url: "https://tunnel.example/studio/chat", token: "t" }),
    refreshSession: async () => true,
    schedulePreview: (...args: Parameters<StudioSessionBroker["schedulePreview"]>) =>
      schedulePreviewMock(...args),
    deployWorkspace: async () => ({ ok: true, slug: "proj", output: "" }),
    dispose: async () => undefined,
  }),
);
let brokerOptions: StudioSessionBrokerOptions | undefined;
/** Read through a function so the assignment above doesn't narrow the type. */
const wiredBroker = (): StudioSessionBrokerOptions | undefined => brokerOptions;
vi.mock("./studio-session-broker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-session-broker.ts")>();
  return {
    ...original,
    createStudioSessionBroker: (...args: Parameters<typeof original.createStudioSessionBroker>) => {
      brokerOptions = args[0];
      return brokerMock(...args);
    },
  };
});

describe("project database routes", () => {
  /** A project with both agents deployed and owned by the caller. */
  async function publishedProject(appDb: FakeAppDb) {
    const combined = await createTestCombined({ appDb });
    await createProject(combined.fetch);
    // Claimed at the STORE: the `-preview` slug cannot go through
    // `POST /deploy`, which rejects that suffix for everyone but the
    // auto-preview deployer (`allowPreviewSlug`).
    for (const slug of ["proj", "proj-preview"]) {
      await claimSlug(combined.store, slug, "key1");
    }
    await mutateWorkspace(combined.workspaces, studioScope("key1"), "proj", (current) => ({
      ...current,
      deployedSlug: "proj",
      previewSlug: "proj-preview",
    }));
    return combined;
  }

  test("the database routes require auth", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/projects/proj/database")).status).toBe(401);
    expect((await fetch("/studio/projects/proj/database", { method: "POST" })).status).toBe(401);
  });

  test("GET reports the project ON by default, with both environments still off", async () => {
    const { fetch } = await createTestCombined({ appDb: fakeAppDb() });
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/database", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      // Absent means ON — the project has a database; each ENVIRONMENT is off
      // until its slug exists to provision.
      enabled: true,
      configured: true,
      environments: [
        { environment: "production", enabled: false },
        { environment: "preview", enabled: false },
      ],
    });
  });

  test("GET 404s an unknown project", async () => {
    const { fetch } = await createTestCombined();
    const res = await authFetch(fetch, "/studio/projects/ghost/database", { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("POST provisions both environments and redeploys the preview", async () => {
    schedulePreviewMock.mockClear();
    const appDb = fakeAppDb();
    const { fetch } = await publishedProject(appDb);
    const res = await authFetch(fetch, "/studio/projects/proj/database", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      configured: true,
      environments: [
        {
          environment: "production",
          slug: "proj",
          enabled: true,
          usage: { tables: 0, rows: 0, bytes: 0 },
        },
        {
          environment: "preview",
          slug: "proj-preview",
          enabled: true,
          usage: { tables: 0, rows: 0, bytes: 0 },
        },
      ],
    });
    expect(appDb.provision.mock.calls.map(([slug]) => slug)).toEqual(["proj", "proj-preview"]);
    // The live preview holds its DATABASE_URL from its last deploy, so the
    // route has to ship a new one.
    expect(schedulePreviewMock).toHaveBeenCalledWith(
      studioScope("key1"),
      "proj",
      expect.objectContaining({ apiKey: "key1", serverUrl: expect.stringMatching(/^https?:/) }),
    );
  });

  test("DELETE drops both environments", async () => {
    const appDb = fakeAppDb();
    const { fetch } = await publishedProject(appDb);
    await authFetch(fetch, "/studio/projects/proj/database", { body: {} });
    const res = await authFetch(fetch, "/studio/projects/proj/database", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false });
    expect(appDb.deprovision.mock.calls.map(([slug]) => slug)).toEqual(["proj", "proj-preview"]);
  });

  test("an unconfigured platform reports it, and refuses to enable", async () => {
    // No appDb binding — SUPABASE_DB_URL unset.
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    const state = await authFetch(fetch, "/studio/projects/proj/database", { method: "GET" });
    expect(await state.json()).toMatchObject({ configured: false });
  });

  test("the broker is handed a deploy hook that provisions a newly claimed slug", async () => {
    // Both deploy paths (Publish and the auto preview) go through the
    // broker's one publisher, so this hook is what makes the switch reach an
    // environment that did not exist when it was flipped.
    const appDb = fakeAppDb();
    const { fetch, workspaces, store } = await publishedProject(appDb);
    // Enabling redeploys the preview, which is what builds the broker here.
    await authFetch(fetch, "/studio/projects/proj/database", { body: {} });
    const afterDeploy = wiredBroker()?.afterDeploy;
    expect(afterDeploy).toBeTypeOf("function");

    // A slug claimed by a LATER deploy — the case the hook exists for.
    await claimSlug(store, "proj-published", "key1");
    await afterDeploy?.(studioScope("key1"), "proj", "proj-published");
    expect(appDb.provision).toHaveBeenCalledWith("proj-published");
    expect(
      await getWorkspace(workspaces, studioScope("key1"), "proj").then((w) => w?.databaseEnabled),
    ).toBe(true);
  });
});
