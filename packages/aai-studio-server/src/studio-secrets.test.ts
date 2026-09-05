// Copyright 2026 the AAI authors. MIT license.
// A project is two deployed agents, and a secret has to reach both — the
// property that used to live in the browser, so every other caller wrote to
// production alone. It also has to reach the agents it does not have YET: the
// panel is usable from the moment a project exists, so the project holds its
// own record and each deploy claims what it is owed.
import { localSlugLock } from "aai-server/platform";
import type { BundleStore } from "aai-server/stores";
import {
  createMemorySecretStore,
  createMemoryWorkspaceStore,
  type SecretStore,
  type WorkspaceStore,
} from "aai-server/stores";
import { createTestStore } from "aai-server/test-utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { claimSlug } from "./_studio-agents-test-utils.ts";
import { secretsDeployHook } from "./studio-secret-routes.ts";
import {
  deleteProjectSecret,
  deleteProjectSecrets,
  type ProjectSecretsEnv,
  projectEnvSecretName,
  projectSecretsState,
  reconcileProjectSecrets,
  setProjectSecrets,
} from "./studio-secrets.ts";
import { getWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope-1";
const PROJECT = "demo";
const KEY = "key1";
const OTHER_KEY = "someone-else";

let env: ProjectSecretsEnv;
let store: BundleStore;
let workspaces: WorkspaceStore;
let secrets: SecretStore;

/** Claim a slug for `apiKey`, so ownership checks pass for it. */
const deployAgent = (slug: string, apiKey = KEY): Promise<void> => claimSlug(store, slug, apiKey);

/** Replace the workspace doc, whatever version it is on. */
async function writeWorkspace(doc: Record<string, unknown>): Promise<void> {
  const existing = await workspaces.get(SCOPE, PROJECT);
  await workspaces.put(SCOPE, PROJECT, { files: {}, ...doc }, existing?.version ?? null);
}

beforeEach(async () => {
  store = createTestStore();
  workspaces = createMemoryWorkspaceStore();
  secrets = createMemorySecretStore();
  env = { store, workspaces, secrets, slugLock: localSlugLock };
  await deployAgent(PROJECT);
  await deployAgent(`${PROJECT}-preview`);
  await writeWorkspace({
    deployedSlug: PROJECT,
    previewSlug: `${PROJECT}-preview`,
    previewHash: "h",
  });
});

const params = { scope: SCOPE, project: PROJECT, apiKey: KEY };

describe("setProjectSecrets", () => {
  test("writes BOTH the production and preview agents", async () => {
    await setProjectSecrets(env, { ...params, updates: { OPENAI_API_KEY: "sk-1" } });
    // The values themselves, read straight from the store: a secret set on
    // the project must be startable by either agent.
    expect(await store.getEnv(PROJECT)).toEqual({ OPENAI_API_KEY: "sk-1" });
    expect(await store.getEnv(`${PROJECT}-preview`)).toEqual({ OPENAI_API_KEY: "sk-1" });
  });

  test("merges rather than replaces, per agent", async () => {
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    await setProjectSecrets(env, { ...params, updates: { B: "2" } });
    expect(await store.getEnv(PROJECT)).toEqual({ A: "1", B: "2" });
    expect(await store.getEnv(`${PROJECT}-preview`)).toEqual({ A: "1", B: "2" });
  });

  test("reports names, never values", async () => {
    const state = await setProjectSecrets(env, { ...params, updates: { OPENAI_API_KEY: "sk-1" } });
    expect(JSON.stringify(state)).not.toContain("sk-1");
    expect(state?.vars).toEqual(["OPENAI_API_KEY"]);
  });

  test("a project with only a production agent writes just that one", async () => {
    // The ordinary state before the first preview deploy lands.
    await writeWorkspace({ deployedSlug: PROJECT });
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    expect(await store.getEnv(PROJECT)).toEqual({ A: "1" });
    expect(await store.getEnv(`${PROJECT}-preview`)).toEqual({});
  });

  /**
   * The 404 has to come BEFORE the record write, not after it. The record went
   * in unconditionally and the existence check lived three statements later
   * inside the per-slug fan-out, so a PUT against a project that does not
   * exist answered 404 having already written a Vault record under that name —
   * and nothing cascades it, because the delete cascade only runs for a
   * project that exists. A later project taking that name inherited a
   * stranger's provider keys on its first deploy.
   */
  test("an unknown project is null, and leaves NO record behind", async () => {
    const state = await setProjectSecrets(env, {
      ...params,
      project: "no-such-project",
      updates: { A: "1" },
    });
    expect(state).toBeNull();
    expect(await secrets.get(projectEnvSecretName(SCOPE, "no-such-project"))).toBeNull();
  });

  test("deleting a key on an unknown project is null, and writes nothing", async () => {
    const state = await deleteProjectSecret(env, {
      ...params,
      project: "no-such-project",
      key: "A",
    });
    expect(state).toBeNull();
    expect(await secrets.get(projectEnvSecretName(SCOPE, "no-such-project"))).toBeNull();
  });

  test("reading an unknown project is null", async () => {
    expect(await projectSecretsState(env, { ...params, project: "no-such-project" })).toBeNull();
  });

  test("redeploys the preview, since a secret reaches an agent when it is BUILT", async () => {
    const schedulePreview = vi.fn();
    await setProjectSecrets(env, { ...params, updates: { A: "1" }, schedulePreview });
    expect(schedulePreview).toHaveBeenCalledTimes(1);
    // Clearing the stamp is what makes the deploy run at all — it no-ops on a
    // matching files hash.
    const workspace = await getWorkspace(workspaces, SCOPE, PROJECT);
    expect(workspace?.previewHash).toBeUndefined();
  });

  test("skips a slug the caller does not own", async () => {
    // A workspace naming a foreign slug must not become a lever on someone
    // else's agent — the rule the delete cascade and the database switch
    // follow, for the same reason.
    await deployAgent("stolen-preview", OTHER_KEY);
    await writeWorkspace({ deployedSlug: PROJECT, previewSlug: "stolen-preview" });
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    expect(await store.getEnv(PROJECT)).toEqual({ A: "1" });
    expect(await store.getEnv("stolen-preview")).toEqual({});
  });
});

describe("projectSecretsState", () => {
  test("lists the union of both agents' names, with each slug", async () => {
    await setProjectSecrets(env, { ...params, updates: { SHARED: "1" } });
    // A name set on production alone (e.g. before the preview existed) still
    // belongs to the project.
    await store.putEnv(PROJECT, { SHARED: "1", PROD_ONLY: "2" });
    const state = await projectSecretsState(env, params);
    expect(state?.vars).toEqual(["PROD_ONLY", "SHARED"]);
    expect(state?.environments).toEqual([
      { environment: "production", slug: PROJECT, vars: ["SHARED", "PROD_ONLY"] },
      { environment: "preview", slug: `${PROJECT}-preview`, vars: ["SHARED"] },
    ]);
  });

  test("an environment with no agent yet reports no slug and no names", async () => {
    await writeWorkspace({ deployedSlug: PROJECT });
    const state = await projectSecretsState(env, params);
    expect(state?.environments[1]).toEqual({ environment: "preview", vars: [] });
  });
});

/**
 * The panel is reachable from the moment a project exists, and an agent needs
 * its provider key to run at all — so a save before anything is deployed has
 * to be durable, not a write that reaches no one.
 */
describe("a project with nothing deployed", () => {
  beforeEach(async () => {
    await writeWorkspace({});
  });

  test("saves the secret and reports it, with no agent to write to", async () => {
    const state = await setProjectSecrets(env, { ...params, updates: { OPENAI_API_KEY: "sk-1" } });
    expect(state?.vars).toEqual(["OPENAI_API_KEY"]);
    // Every environment is waiting on a deploy, and the panel says so.
    expect(state?.pending).toEqual(["OPENAI_API_KEY"]);
    expect(state?.environments.every((e) => e.slug === undefined)).toBe(true);
  });

  test("the first deploy of either environment picks it up", async () => {
    await setProjectSecrets(env, { ...params, updates: { OPENAI_API_KEY: "sk-1" } });
    // What a deploy does: claim the slug, then run the post-deploy hook.
    await writeWorkspace({ previewSlug: `${PROJECT}-preview` });
    await reconcileProjectSecrets(env, {
      scope: SCOPE,
      project: PROJECT,
      slug: `${PROJECT}-preview`,
    });
    expect(await store.getEnv(`${PROJECT}-preview`)).toEqual({ OPENAI_API_KEY: "sk-1" });
    expect((await projectSecretsState(env, params))?.pending).toEqual(["OPENAI_API_KEY"]);
  });

  test("nothing is left behind once both environments carry it", async () => {
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    await writeWorkspace({ deployedSlug: PROJECT, previewSlug: `${PROJECT}-preview` });
    for (const slug of [PROJECT, `${PROJECT}-preview`]) {
      await reconcileProjectSecrets(env, { scope: SCOPE, project: PROJECT, slug });
    }
    expect((await projectSecretsState(env, params))?.pending).toEqual([]);
  });
});

describe("reconcileProjectSecrets", () => {
  test("never overrides a value the slug already carries", async () => {
    // `aai secret put` against one slug must not be reinstated to the
    // studio's value by the next unrelated deploy.
    await setProjectSecrets(env, { ...params, updates: { A: "studio" } });
    await store.putEnv(PROJECT, { A: "cli-set-later" });
    await reconcileProjectSecrets(env, { scope: SCOPE, project: PROJECT, slug: PROJECT });
    expect(await store.getEnv(PROJECT)).toEqual({ A: "cli-set-later" });
  });

  test("a project holding nothing writes nothing", async () => {
    await store.putEnv(PROJECT, { EXISTING: "1" });
    await reconcileProjectSecrets(env, { scope: SCOPE, project: PROJECT, slug: PROJECT });
    expect(await store.getEnv(PROJECT)).toEqual({ EXISTING: "1" });
  });
});

describe("deleteProjectSecrets", () => {
  test("a deleted project takes its record with it", async () => {
    // A project name can be claimed again — the next one must not inherit a
    // dead project's provider keys.
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    await deleteProjectSecrets(env, SCOPE, PROJECT);
    expect(await secrets.get(projectEnvSecretName(SCOPE, PROJECT))).toBeNull();
  });
});

describe("deleteProjectSecret", () => {
  test("drops the name from the project's own record too", async () => {
    // Otherwise the next deploy of either agent puts it straight back.
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    await deleteProjectSecret(env, { ...params, key: "A" });
    await store.putEnv(PROJECT, {});
    await reconcileProjectSecrets(env, { scope: SCOPE, project: PROJECT, slug: PROJECT });
    expect(await store.getEnv(PROJECT)).toEqual({});
  });

  test("drops the name from both agents", async () => {
    await setProjectSecrets(env, { ...params, updates: { A: "1", B: "2" } });
    await deleteProjectSecret(env, { ...params, key: "A" });
    expect(await store.getEnv(PROJECT)).toEqual({ B: "2" });
    expect(await store.getEnv(`${PROJECT}-preview`)).toEqual({ B: "2" });
  });

  test("deleting a name that was never set is a no-op, not an error", async () => {
    const state = await deleteProjectSecret(env, { ...params, key: "NEVER_SET" });
    expect(state?.vars).toEqual([]);
  });
});

/**
 * The request-bound wrapper, which is the only post-deploy hook left.
 *
 * `studio-database-routes.test.ts` used to reach this path incidentally, through
 * the composed pair of hooks; it went with per-app databases and took the one
 * statement covering the returned closure with it. Covered directly now, because
 * the property is worth its own claim: the hook reads the request ENV up front and
 * the function it returns touches no Context, which is what makes it safe to hand
 * to a broker that outlives the request.
 */
describe("secretsDeployHook", () => {
  test("gives a freshly claimed slug the secrets its project already holds", async () => {
    await setProjectSecrets(env, { ...params, updates: { A: "1" } });
    const late = `${PROJECT}-late`;
    await deployAgent(late);
    expect(await store.getEnv(late)).toEqual({});

    // The bindings alone — no Context. That this type-checks IS the property.
    const hook = secretsDeployHook({
      env: { workspaces, store, secrets, slugLock: localSlugLock },
    });
    await hook(SCOPE, PROJECT, late);

    expect(await store.getEnv(late)).toEqual({ A: "1" });
  });
});
