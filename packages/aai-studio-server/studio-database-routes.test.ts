// Copyright 2026 the AAI authors. MIT license.
// The project database's HTTP surface, through the full combined app: one
// switch that reaches BOTH of a project's deployed agents, and the deploy
// hook that catches an environment which did not exist when it was flipped.
// The switch's own behavior lives in studio-database.test.ts.

import { hashApiKey } from "aai-server/secrets";
import type { BundleStore } from "aai-server/store-types";
import { authFetch, type TestFetch } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";
import type { StudioSessionBroker, StudioSessionBrokerOptions } from "./studio-session-broker.ts";
import { getWorkspace, mutateWorkspace, studioScope } from "./studio-workspace.ts";

// The broker is faked: enabling the database schedules a preview deploy, and
// a real broker would try to spawn a harness for it. Capturing the options is
// also how the long-lived `afterDeploy` hook is asserted.
const schedulePreviewMock = vi.fn();
const brokerMock = vi.fn(
  (): StudioSessionBroker => ({
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
    createStudioSessionBroker: (...args: unknown[]) => {
      brokerOptions = args[0] as StudioSessionBrokerOptions;
      return brokerMock(...(args as []));
    },
  };
});

function createProject(fetch: TestFetch, name = "proj", key = "key1"): Promise<Response> {
  return authFetch(fetch, "/studio/projects", { body: { name }, key });
}

describe("project database routes", () => {
  /** Provisioning double — the route's job is reaching it for both slugs. */
  function fakeAppDb() {
    return {
      provision: vi.fn(async (slug: string) => ({
        role: `app_${slug.replace(/\W/g, "").slice(0, 16).padEnd(16, "0")}`,
        password: "f".repeat(32),
      })),
      deprovision: vi.fn(async (_slug: string) => undefined),
      connectionUrl: () => "postgres://app@db/app",
      usage: async () => ({ tables: 0, rows: 0, bytes: 0 }),
    };
  }

  /**
   * Claim a slug for `key1` at the store. The `-preview` slug cannot go
   * through `POST /deploy` — the deploy boundary rejects that suffix for
   * everyone but the auto-preview deployer, which passes `allowPreviewSlug`.
   */
  function claim(store: BundleStore, slug: string): Promise<void> {
    return store.putAgent({
      slug,
      env: {},
      worker: "export default {}",
      clientFiles: {},
      credential_hashes: [hashApiKey("key1")],
    });
  }

  /** A project with both agents deployed and owned by the caller. */
  async function publishedProject(appDb: ReturnType<typeof fakeAppDb>) {
    const combined = await createTestCombined({ appDb });
    await createProject(combined.fetch);
    for (const slug of ["proj", "proj-preview"]) {
      await claim(combined.store, slug);
    }
    await mutateWorkspace(combined.workspaces, studioScope("key1"), "proj", (current) => ({
      ...current,
      deployedSlug: "proj",
      previewSlug: "proj-preview",
    }));
    return combined;
  }

  test("a WORKFLOW project asks for the database on creation; an agent project does not", async () => {
    // The journal IS the durability, so a workflow project without storage boots,
    // answers calls, and rejects every `ctx.workflows` call with
    // `WORKFLOWS_UNAVAILABLE_MESSAGE` — inert at the one thing it exists for,
    // with the fix two panes away. Storage is incidental to a voice agent, hence
    // the default differs by kind rather than being on for everyone.
    const { fetch, workspaces } = await createTestCombined();
    await authFetch(fetch, "/studio/projects", { body: { name: "flow", kind: "workflow" } });
    await authFetch(fetch, "/studio/projects", { body: { name: "voice" } });

    const scope = studioScope("key1");
    expect(await getWorkspace(workspaces, scope, "flow").then((w) => w?.databaseEnabled)).toBe(
      true,
    );
    // Absent, not `false` — see StudioWorkspace.databaseEnabled.
    expect(
      await getWorkspace(workspaces, scope, "voice").then((w) => w?.databaseEnabled),
    ).toBeUndefined();
  });

  test("creation stamps INTENT only — no slug exists yet to provision", async () => {
    // Provisioning a slug nobody has claimed creates a schema outliving every
    // cleanup path (both key off an agents row) that another tenant could inherit
    // by claiming the name first. The first deploy provisions, through
    // `reconcileProjectDatabase`.
    const appDb = fakeAppDb();
    const { fetch } = await createTestCombined({ appDb });
    await authFetch(fetch, "/studio/projects", { body: { name: "flow", kind: "workflow" } });

    expect(appDb.provision).not.toHaveBeenCalled();
  });

  test("the database routes require auth", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/projects/proj/database")).status).toBe(401);
    expect((await fetch("/studio/projects/proj/database", { method: "POST" })).status).toBe(401);
  });

  test("GET reports both environments, off, before anything is deployed", async () => {
    const { fetch } = await createTestCombined({ appDb: fakeAppDb() });
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/database", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
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
    await claim(store, "proj-published");
    await afterDeploy?.(studioScope("key1"), "proj", "proj-published");
    expect(appDb.provision).toHaveBeenCalledWith("proj-published");
    expect(
      await getWorkspace(workspaces, studioScope("key1"), "proj").then((w) => w?.databaseEnabled),
    ).toBe(true);
  });
});
