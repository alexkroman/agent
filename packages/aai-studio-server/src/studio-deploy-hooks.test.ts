// Copyright 2026 the AAI authors. MIT license.
// The one post-deploy hook the session broker is handed
// (studio-deploy-hooks.ts): built from a request's Context, run after that
// request has answered. What the secrets reconcile itself writes is
// studio-secrets.test.ts.

import { localSlugLock } from "aai-server/platform";
import {
  type BundleStore,
  createMemorySecretStore,
  createMemoryWorkspaceStore,
  type SecretStore,
  type WorkspaceStore,
} from "aai-server/stores";
import { createTestStore } from "aai-server/test-utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { claimSlug } from "./_studio-agents-test-utils.ts";
import type { StudioHonoEnv } from "./studio-context.ts";
import { createAfterDeploy } from "./studio-deploy-hooks.ts";
import { setProjectSecrets } from "./studio-secrets.ts";
import type { AfterDeploy } from "./studio-session-publish.ts";
import { createWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope-1";
const PROJECT = "demo";
const KEY = "key1";

let store: BundleStore;
let workspaces: WorkspaceStore;
let secrets: SecretStore;

beforeEach(async () => {
  store = createTestStore();
  workspaces = createMemoryWorkspaceStore();
  secrets = createMemorySecretStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, { kind: "agent", files: {} });
});

/**
 * The hook a real request builds, captured and returned once that request has
 * answered — the shape the broker holds it in.
 */
async function hookFromRequest(): Promise<AfterDeploy> {
  let hook: AfterDeploy | undefined;
  const app = new Hono<StudioHonoEnv>();
  app.post("/deploy", (c) => {
    hook = createAfterDeploy(c);
    return c.json({ ok: true });
  });
  const res = await app.request(
    "/deploy",
    { method: "POST" },
    { store, workspaces, secrets, slugLock: localSlugLock },
  );
  if (res.status !== 200 || !hook) throw new Error(`the route answered ${res.status}`);
  return hook;
}

describe("createAfterDeploy", () => {
  test("gives a freshly claimed slug the secrets its project holds, after the request", async () => {
    // Saved before anything was deployed — the ordinary state.
    await setProjectSecrets(
      { store, workspaces, secrets, slugLock: localSlugLock },
      { scope: SCOPE, project: PROJECT, apiKey: KEY, updates: { OPENAI_API_KEY: "sk-1" } },
    );
    await claimSlug(store, PROJECT, KEY);
    const afterDeploy = await hookFromRequest();

    await afterDeploy(SCOPE, PROJECT, PROJECT);

    expect(await store.getEnv(PROJECT)).toEqual({ OPENAI_API_KEY: "sk-1" });
  });

  test("a project holding no secrets writes nothing", async () => {
    await claimSlug(store, PROJECT, KEY);
    const afterDeploy = await hookFromRequest();

    await afterDeploy(SCOPE, PROJECT, PROJECT);

    expect(await store.getEnv(PROJECT)).toEqual({});
  });
});
