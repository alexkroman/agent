// Copyright 2026 the AAI authors. MIT license.
// The project database switch: one control over BOTH of a project's deployed
// agents. The properties worth pinning are the ones a per-slug toggle would
// have got wrong — that the two environments get DIFFERENT schemas, that a
// switch flipped before an environment exists still reaches it when its
// deploy does, that an already-provisioned database is never re-provisioned
// (that rotates the password a live sandbox is holding), and that a foreign
// slug named by the workspace is not a lever on someone else's agent.

import { type AppDatabases, type AppDbMeta, appDbIdentifier } from "aai-server/app-database";
import { localSlugLock } from "aai-server/platform-lock";
import { createMemorySecretStore, type SecretStore } from "aai-server/secret-store";
import { hashApiKey } from "aai-server/secrets";
import type { BundleStore } from "aai-server/store-types";
import { createTestStore } from "aai-server/test-utils";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import {
  type ProjectDatabaseEnv,
  projectDatabaseState,
  reconcileProjectDatabase,
  setProjectDatabase,
} from "./studio-database.ts";
import { createWorkspace, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope-1";
const PROJECT = "demo";
const KEY = "key-1";

/** Provisioning that records its calls and mints a per-slug meta. */
function fakeAppDb(): AppDatabases & {
  provision: ReturnType<typeof vi.fn>;
  deprovision: ReturnType<typeof vi.fn>;
} {
  return {
    provision: vi.fn(
      async (slug: string): Promise<AppDbMeta> => ({
        role: appDbIdentifier(slug),
        // A fresh password every call — the real provisioner rotates too,
        // which is why an enabled slug must never be re-provisioned.
        password: Math.random().toString(16).slice(2).padEnd(32, "0"),
      }),
    ),
    deprovision: vi.fn(async () => undefined),
    connectionUrl: () => "postgres://app@db/app",
    usage: async () => ({ tables: 0, rows: 0, bytes: 0 }),
  };
}

type Harness = {
  env: ProjectDatabaseEnv & { appDb: ReturnType<typeof fakeAppDb> };
  workspaces: WorkspaceStore;
  secrets: SecretStore;
  store: BundleStore;
};

async function harness(
  workspace: { deployedSlug?: string; previewSlug?: string } = {},
  opts: { appDb?: boolean } = {},
): Promise<Harness> {
  const workspaces = createMemoryWorkspaceStore();
  const secrets = createMemorySecretStore();
  const store = createTestStore(secrets);
  const appDb = fakeAppDb();
  await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "" }, ...workspace });
  // Every slug the workspace names is a real deployed agent owned by KEY,
  // unless a test claims one for somebody else.
  for (const slug of [workspace.deployedSlug, workspace.previewSlug].filter(Boolean)) {
    await claim(store, slug as string, KEY);
  }
  const env = {
    workspaces,
    store,
    secrets,
    ...(opts.appDb === false ? {} : { appDb }),
    slugLock: localSlugLock,
  } as Harness["env"];
  return { env, workspaces, secrets, store };
}

/** Deploy a slug owned by `key` — what makes `verifySlugOwner` say "owned". */
function claim(store: BundleStore, slug: string, key: string): Promise<void> {
  return store.putAgent({
    slug,
    env: {},
    worker: "export default {}",
    clientFiles: {},
    credential_hashes: [hashApiKey(key)],
  });
}

/** The provisioned-credential record — the platform's own "is it enabled". */
function appDbSecret(secrets: SecretStore, slug: string): Promise<string | null> {
  return secrets.get(`app-db:${slug}`);
}

const enable = (h: Harness, extra: { schedulePreview?: () => void } = {}) =>
  setProjectDatabase(h.env, {
    scope: SCOPE,
    project: PROJECT,
    apiKey: KEY,
    enabled: true,
    ...extra,
  });

describe("setProjectDatabase", () => {
  test("provisions both environments, each with its OWN schema", async () => {
    const h = await harness({ deployedSlug: "demo", previewSlug: "demo-preview" });
    const state = await enable(h);
    expect(state?.enabled).toBe(true);
    expect(state?.environments).toEqual([
      {
        environment: "production",
        slug: "demo",
        enabled: true,
        usage: { tables: 0, rows: 0, bytes: 0 },
      },
      {
        environment: "preview",
        slug: "demo-preview",
        enabled: true,
        usage: { tables: 0, rows: 0, bytes: 0 },
      },
    ]);
    expect(h.env.appDb.provision.mock.calls.map(([slug]) => slug)).toEqual([
      "demo",
      "demo-preview",
    ]);
    // Distinct identifiers is the whole point: a preview run must not be able
    // to drop the production table.
    const production = await appDbSecret(h.secrets, "demo");
    const preview = await appDbSecret(h.secrets, "demo-preview");
    expect(production).not.toBeNull();
    expect(preview).not.toBeNull();
    expect(production).not.toEqual(preview);
  });

  test("stamps the project's intent, so an environment that appears later gets one", async () => {
    // No deploys yet — the usual state when someone switches this on.
    const h = await harness();
    const state = await enable(h);
    expect(state?.enabled).toBe(true);
    expect(state?.environments.every((row) => row.enabled === false)).toBe(true);
    // Nothing provisioned: there is no owned slug to provision for.
    expect(h.env.appDb.provision).not.toHaveBeenCalled();
    expect((await getWorkspace(h.workspaces, SCOPE, PROJECT))?.databaseEnabled).toBe(true);

    // …and the first deploy of either agent picks it up.
    await claim(h.store, "demo-preview", KEY);
    await reconcileProjectDatabase(h.env, { scope: SCOPE, project: PROJECT, slug: "demo-preview" });
    expect(h.env.appDb.provision).toHaveBeenCalledWith("demo-preview");
    expect(await appDbSecret(h.secrets, "demo-preview")).not.toBeNull();
  });

  test("an already-provisioned slug is never re-provisioned", async () => {
    // Re-provisioning rotates the role's password, which would invalidate the
    // DATABASE_URL the running sandbox holds.
    const h = await harness({ deployedSlug: "demo" });
    await enable(h);
    const credentials = await appDbSecret(h.secrets, "demo");
    h.env.appDb.provision.mockClear();

    await enable(h);
    await reconcileProjectDatabase(h.env, { scope: SCOPE, project: PROJECT, slug: "demo" });
    expect(h.env.appDb.provision).not.toHaveBeenCalled();
    expect(await appDbSecret(h.secrets, "demo")).toEqual(credentials);
  });

  test("disabling drops both schemas and clears the intent", async () => {
    const h = await harness({ deployedSlug: "demo", previewSlug: "demo-preview" });
    await enable(h);
    const state = await setProjectDatabase(h.env, {
      scope: SCOPE,
      project: PROJECT,
      apiKey: KEY,
      enabled: false,
    });
    expect(state?.enabled).toBe(false);
    expect(state?.environments.every((row) => row.enabled === false)).toBe(true);
    expect(h.env.appDb.deprovision.mock.calls.map(([slug]) => slug)).toEqual([
      "demo",
      "demo-preview",
    ]);
    expect(await appDbSecret(h.secrets, "demo")).toBeNull();
    expect((await getWorkspace(h.workspaces, SCOPE, PROJECT))?.databaseEnabled).toBeUndefined();
    // Cleared intent means a later deploy must NOT hand the agent a database
    // back — the switch is off.
    h.env.appDb.provision.mockClear();
    await reconcileProjectDatabase(h.env, { scope: SCOPE, project: PROJECT, slug: "demo" });
    expect(h.env.appDb.provision).not.toHaveBeenCalled();
  });

  test("force-redeploys the preview so the running agent picks the change up", async () => {
    // DATABASE_URL is read when a sandbox is BUILT, so nothing reaches the
    // live preview without a deploy — and the deploy no-ops on a matching
    // files hash, which is why the stamp has to go.
    const h = await harness({ previewSlug: "demo-preview" });
    await mutateWorkspace(h.workspaces, SCOPE, PROJECT, (current) => ({
      ...current,
      previewHash: "stale-but-current",
    }));
    const schedulePreview = vi.fn();
    await enable(h, { schedulePreview });
    expect(schedulePreview).toHaveBeenCalledTimes(1);
    expect((await getWorkspace(h.workspaces, SCOPE, PROJECT))?.previewHash).toBeUndefined();
  });

  test("no preview agent yet means nothing to redeploy", async () => {
    const h = await harness({ deployedSlug: "demo" });
    const schedulePreview = vi.fn();
    await enable(h, { schedulePreview });
    expect(schedulePreview).not.toHaveBeenCalled();
  });

  test("a slug the caller does not own is left alone", async () => {
    const h = await harness({ deployedSlug: "demo", previewSlug: "demo-preview" });
    // Someone else's agent, however the workspace came to name it.
    await claim(h.store, "demo", "other-key");
    const state = await enable(h);
    expect(h.env.appDb.provision.mock.calls.map(([slug]) => slug)).toEqual(["demo-preview"]);
    // And its state is reported as "no database here" rather than reading
    // whether the real owner has one.
    expect(state?.environments).toEqual([
      { environment: "production", slug: "demo", enabled: false },
      {
        environment: "preview",
        slug: "demo-preview",
        enabled: true,
        usage: { tables: 0, rows: 0, bytes: 0 },
      },
    ]);
  });

  test("an unconfigured platform fails the request rather than silently no-oping", async () => {
    const h = await harness({ deployedSlug: "demo" }, { appDb: false });
    await expect(enable(h)).rejects.toThrow(/not configured/);
  });

  test("one environment failing rides back as a warning beside the real state", async () => {
    const h = await harness({ deployedSlug: "demo", previewSlug: "demo-preview" });
    h.env.appDb.provision.mockImplementation(async (slug: string) => {
      if (slug === "demo-preview") throw new Error("cluster unavailable");
      return { role: appDbIdentifier(slug), password: "f".repeat(32) };
    });
    const state = await enable(h);
    expect(state?.warning).toMatch(/preview/);
    expect(state?.environments).toEqual([
      {
        environment: "production",
        slug: "demo",
        enabled: true,
        usage: { tables: 0, rows: 0, bytes: 0 },
      },
      { environment: "preview", slug: "demo-preview", enabled: false },
    ]);
  });

  test("a missing project is null, not a provisioning attempt", async () => {
    const h = await harness();
    const state = await setProjectDatabase(h.env, {
      scope: SCOPE,
      project: "ghost",
      apiKey: KEY,
      enabled: true,
    });
    expect(state).toBeNull();
    expect(h.env.appDb.provision).not.toHaveBeenCalled();
  });
});

describe("projectDatabaseState", () => {
  test("reports off, configured, and both environments before anything is deployed", async () => {
    const h = await harness();
    expect(
      await projectDatabaseState(h.env, { scope: SCOPE, project: PROJECT, apiKey: KEY }),
    ).toEqual({
      enabled: false,
      configured: true,
      environments: [
        { environment: "production", enabled: false },
        { environment: "preview", enabled: false },
      ],
    });
  });

  test("reports an unconfigured platform, so the client can hide the switch", async () => {
    const h = await harness({}, { appDb: false });
    const state = await projectDatabaseState(h.env, {
      scope: SCOPE,
      project: PROJECT,
      apiKey: KEY,
    });
    expect(state?.configured).toBe(false);
  });

  test("a missing project is null", async () => {
    const h = await harness();
    expect(
      await projectDatabaseState(h.env, { scope: SCOPE, project: "ghost", apiKey: KEY }),
    ).toBeNull();
  });
});

describe("reconcileProjectDatabase", () => {
  test("does nothing when the project never asked for a database", async () => {
    const h = await harness({ deployedSlug: "demo" });
    await reconcileProjectDatabase(h.env, { scope: SCOPE, project: PROJECT, slug: "demo" });
    expect(h.env.appDb.provision).not.toHaveBeenCalled();
  });

  test("does nothing on a platform that cannot provision", async () => {
    const h = await harness({ deployedSlug: "demo" }, { appDb: false });
    await mutateWorkspace(h.workspaces, SCOPE, PROJECT, (current) => ({
      ...current,
      databaseEnabled: true,
    }));
    // A deploy must not fail because storage is unconfigured.
    await expect(
      reconcileProjectDatabase(h.env, { scope: SCOPE, project: PROJECT, slug: "demo" }),
    ).resolves.toBeUndefined();
  });
});
