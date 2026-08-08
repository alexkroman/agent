// Copyright 2026 the AAI authors. MIT license.
// A project is two deployed agents, and a secret has to reach both — the
// property that used to live in the browser, so every other caller wrote to
// production alone.
import { localSlugLock } from "aai-server/platform-lock";
import { hashApiKey } from "aai-server/secrets";
import type { BundleStore } from "aai-server/store-types";
import { createTestStore } from "aai-server/test-utils";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "aai-server/workspace-store";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deleteProjectSecret,
  type ProjectSecretsEnv,
  projectSecretsState,
  setProjectSecrets,
} from "./studio-secrets.ts";

const SCOPE = "scope-1";
const PROJECT = "demo";
const KEY = "key1";
const OTHER_KEY = "someone-else";

let env: ProjectSecretsEnv;
let store: BundleStore;
let workspaces: WorkspaceStore;

/** Claim a slug for `apiKey`, so ownership checks pass for it. */
async function deployAgent(slug: string, apiKey = KEY): Promise<void> {
  await store.putAgent({
    slug,
    env: {},
    worker: "export default {};",
    clientFiles: {},
    credential_hashes: [hashApiKey(apiKey)],
  });
}

/** Replace the workspace doc, whatever version it is on. */
async function writeWorkspace(doc: Record<string, unknown>): Promise<void> {
  const existing = await workspaces.get(SCOPE, PROJECT);
  await workspaces.put(SCOPE, PROJECT, { files: {}, ...doc }, existing?.version ?? null);
}

beforeEach(async () => {
  store = createTestStore();
  workspaces = createMemoryWorkspaceStore();
  env = { store, workspaces, slugLock: localSlugLock };
  await deployAgent(PROJECT);
  await deployAgent(`${PROJECT}-preview`);
  await writeWorkspace({ deployedSlug: PROJECT, previewSlug: `${PROJECT}-preview` });
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

  test("an unknown project is null, not an empty write", async () => {
    const state = await setProjectSecrets(env, {
      ...params,
      project: "no-such-project",
      updates: { A: "1" },
    });
    expect(state).toBeNull();
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

describe("deleteProjectSecret", () => {
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
