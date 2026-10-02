// Copyright 2026 the AAI authors. MIT license.
// The HTTP surface of a project's secrets (studio-secret-routes.ts), driven
// through the combined harness so the auth and project middleware in front of
// it are the real ones. The storage semantics (floor-not-override, record
// before fan-out) are studio-secrets.test.ts's; this suite owns who may reach
// the routes, what they accept, and what they say back.

import { createMemorySecretStore, type SecretStore } from "aai-server/stores";
import type { TestFetch } from "aai-server/test-utils";
import { authFetch, captureLogs } from "aai-server/test-utils";
import { beforeEach, describe, expect, test } from "vitest";
import { claimSlug } from "./_studio-agents-test-utils.ts";
import { devToken, onboardKey } from "./_studio-auth-test-utils.ts";
import {
  createFakedCombined,
  createProject,
  schedulePreviewMock,
  withFakedDevAuth,
} from "./_studio-routes-test-utils.ts";
import { projectEnvSecretName } from "./studio-secrets.ts";
import { studioScope } from "./studio-workspace.ts";

type Harness = Awaited<ReturnType<typeof createFakedCombined>> & { secrets: SecretStore };

/** The faked harness, holding on to the SecretStore the routes write to. */
async function harness(): Promise<Harness> {
  const secrets = createMemorySecretStore();
  return { ...(await createFakedCombined({ secrets })), secrets };
}
type State = {
  vars: string[];
  environments: { environment: string; slug?: string; vars: string[] }[];
  pending: string[];
};

const OWNER = "key1";
const STRANGER = "someone-else";
// A value no name, slug or hash in this suite could contain by accident, so
// "the response does not contain it" means what it says.
const VALUE = "sk-live-VALUE-must-never-leave-the-vault";

const secretPath = (project: string, key?: string): string =>
  `/studio/projects/${project}/secret${key === undefined ? "" : `/${key}`}`;

const put = (fetch: TestFetch, project: string, body: unknown, key = OWNER) =>
  authFetch(fetch, secretPath(project), { method: "PUT", body, key });
const get = (fetch: TestFetch, project: string, key = OWNER) =>
  authFetch(fetch, secretPath(project), { method: "GET", key });
const del = (fetch: TestFetch, project: string, name: string, key = OWNER) =>
  authFetch(fetch, secretPath(project, name), { method: "DELETE", key });

/**
 * A project of `key`'s whose doc names both agents. The slugs are claimed by
 * the caller in `beforeEach`; a test passing someone else's is the point.
 */
async function projectWithAgents(
  h: Harness,
  project: string,
  key = OWNER,
  slugs = { production: project, preview: `${project}-preview` },
): Promise<void> {
  const created = await createProject(h.fetch, project, key);
  if (created.status !== 201) throw new Error(`creating ${project} answered ${created.status}`);
  await h.workspaces.patch(studioScope(key), project, {
    set: { deployedSlug: slugs.production, previewSlug: slugs.preview, previewHash: "h" },
  });
}

describe("project secret routes", () => {
  const logs = captureLogs();
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
    await claimSlug(h.store, "proj", OWNER);
    await claimSlug(h.store, "proj-preview", OWNER);
    await projectWithAgents(h, "proj");
    // Creating a project is a settled edit and schedules a preview of its own.
    schedulePreviewMock.mockClear();
  });

  describe("authentication", () => {
    test.each([
      ["GET", secretPath("proj")],
      ["PUT", secretPath("proj")],
      ["DELETE", secretPath("proj", "A")],
    ])("%s without a bearer is 401 and touches nothing", async (method, path) => {
      const res = await h.fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ A: VALUE }) } : {}),
      });
      expect(res.status).toBe(401);
      expect(await h.store.getEnv("proj")).toEqual({});
    });
  });

  describe("writes reach both agents, answers carry names only", () => {
    test("PUT stores the value on both agents and the project record", async () => {
      const res = await put(h.fetch, "proj", { OPENAI_API_KEY: VALUE });
      expect(res.status).toBe(200);
      expect(await h.store.getEnv("proj")).toEqual({ OPENAI_API_KEY: VALUE });
      expect(await h.store.getEnv("proj-preview")).toEqual({ OPENAI_API_KEY: VALUE });
      const record = await h.secrets.get(projectEnvSecretName(studioScope(OWNER), "proj"));
      expect(JSON.parse(record ?? "{}")).toEqual({ OPENAI_API_KEY: VALUE });
    });

    test("no response of any of the three routes echoes a value", async () => {
      const putRes = await put(h.fetch, "proj", { OPENAI_API_KEY: VALUE, OTHER: `${VALUE}-2` });
      const putText = await putRes.text();
      expect(putText).not.toContain(VALUE);
      expect(JSON.parse(putText)).toEqual({
        vars: ["OPENAI_API_KEY", "OTHER"],
        environments: [
          { environment: "production", slug: "proj", vars: ["OPENAI_API_KEY", "OTHER"] },
          { environment: "preview", slug: "proj-preview", vars: ["OPENAI_API_KEY", "OTHER"] },
        ],
        pending: [],
      });

      const getText = await (await get(h.fetch, "proj")).text();
      expect(getText).not.toContain(VALUE);
      expect((JSON.parse(getText) as State).vars).toEqual(["OPENAI_API_KEY", "OTHER"]);

      const delRes = await del(h.fetch, "proj", "OTHER");
      expect(delRes.status).toBe(200);
      const delText = await delRes.text();
      expect(delText).not.toContain(VALUE);
      expect((JSON.parse(delText) as State).vars).toEqual(["OPENAI_API_KEY"]);
    });

    test("no log line written while setting, reading or deleting carries a value", async () => {
      await put(h.fetch, "proj", { OPENAI_API_KEY: VALUE });
      await get(h.fetch, "proj");
      await del(h.fetch, "proj", "OPENAI_API_KEY");
      expect(JSON.stringify(logs.all())).not.toContain(VALUE);
    });

    test("DELETE drops the name from both agents and from the record", async () => {
      await put(h.fetch, "proj", { A: VALUE, B: "b" });
      const res = await del(h.fetch, "proj", "A");
      expect(res.status).toBe(200);
      expect(await h.store.getEnv("proj")).toEqual({ B: "b" });
      expect(await h.store.getEnv("proj-preview")).toEqual({ B: "b" });
      // Deleting the last name deletes the record outright.
      await del(h.fetch, "proj", "B");
      expect(await h.secrets.get(projectEnvSecretName(studioScope(OWNER), "proj"))).toBeNull();
    });

    test("GET on a project that has deployed nothing lists its record as pending", async () => {
      expect((await createProject(h.fetch, "fresh")).status).toBe(201);
      await put(h.fetch, "fresh", { A: VALUE });
      const state = (await (await get(h.fetch, "fresh")).json()) as State;
      expect(state).toEqual({
        vars: ["A"],
        environments: [
          { environment: "production", vars: [] },
          { environment: "preview", vars: [] },
        ],
        pending: ["A"],
      });
    });
  });

  describe("the preview redeploy a mutation arms", () => {
    test("PUT and DELETE schedule it on the CALLER's key", async () => {
      await put(h.fetch, "proj", { A: VALUE });
      await del(h.fetch, "proj", "A");
      expect(schedulePreviewMock).toHaveBeenCalledTimes(2);
      for (const [scope, project, target] of schedulePreviewMock.mock.calls) {
        expect(scope).toBe(studioScope(OWNER));
        expect(project).toBe("proj");
        expect(target).toMatchObject({
          apiKey: OWNER,
          serverUrl: expect.stringMatching(/^https?:/),
        });
      }
    });

    test("nothing is scheduled for a project with no preview agent yet", async () => {
      expect((await createProject(h.fetch, "fresh")).status).toBe(201);
      schedulePreviewMock.mockClear();
      await put(h.fetch, "fresh", { A: VALUE });
      expect(schedulePreviewMock).not.toHaveBeenCalled();
    });

    test("GET never schedules one", async () => {
      await get(h.fetch, "proj");
      expect(schedulePreviewMock).not.toHaveBeenCalled();
    });
  });

  describe("isolation", () => {
    test("another caller's same-named project is THEIR namespace: 404, nothing read or written", async () => {
      await put(h.fetch, "proj", { A: VALUE });

      expect((await get(h.fetch, "proj", STRANGER)).status).toBe(404);
      expect((await put(h.fetch, "proj", { A: "overwritten" }, STRANGER)).status).toBe(404);
      expect((await del(h.fetch, "proj", "A", STRANGER)).status).toBe(404);

      expect(await h.store.getEnv("proj")).toEqual({ A: VALUE });
      expect(await h.store.getEnv("proj-preview")).toEqual({ A: VALUE });
      // And the 404 PUT left no record in the stranger's scope for a later
      // project of that name to inherit.
      expect(await h.secrets.get(projectEnvSecretName(studioScope(STRANGER), "proj"))).toBeNull();
      expect(schedulePreviewMock).toHaveBeenCalledTimes(1);
    });

    test("a project whose doc names agents its caller does not own reaches neither", async () => {
      // The stranger's own project, its doc pointing at the owner's slugs —
      // what a forged or stale `deployedSlug` would look like.
      await put(h.fetch, "proj", { A: VALUE });
      await projectWithAgents(h, "mine", STRANGER, { production: "proj", preview: "proj-preview" });

      const res = await put(h.fetch, "mine", { A: "hijacked", B: "planted" }, STRANGER);
      expect(res.status).toBe(200);
      const state = (await res.json()) as State;
      // Not listed as the stranger's environments, so not even the NAMES leak.
      expect(state.environments).toEqual([
        { environment: "production", vars: [] },
        { environment: "preview", vars: [] },
      ]);
      expect(await h.store.getEnv("proj")).toEqual({ A: VALUE });
      expect(await h.store.getEnv("proj-preview")).toEqual({ A: VALUE });

      expect((await del(h.fetch, "mine", "A", STRANGER)).status).toBe(200);
      expect(await h.store.getEnv("proj")).toEqual({ A: VALUE });

      const read = (await (await get(h.fetch, "mine", STRANGER)).json()) as State;
      expect(read.vars).toEqual(["B"]);
    });

    test("two projects of one caller keep separate records", async () => {
      expect((await createProject(h.fetch, "other")).status).toBe(201);
      await put(h.fetch, "proj", { A: VALUE });
      await put(h.fetch, "other", { B: "b" });
      expect(((await (await get(h.fetch, "proj")).json()) as State).vars).toEqual(["A"]);
      expect(((await (await get(h.fetch, "other")).json()) as State).vars).toEqual(["B"]);
    });
  });

  describe("input validation", () => {
    test.each([
      ["a name starting with a digit", { "1ABC": "v" }],
      ["a name with a dash", { "MY-KEY": "v" }],
      ["a name with a space", { "MY KEY": "v" }],
      ["an empty name", { "": "v" }],
      ["a non-string value", { A: 1 }],
      ["a null value", { A: null }],
      ["a nested value", { A: { nested: "v" } }],
      ["an array body", ["A", "v"]],
      ["a string body", "A=v"],
      ["a null body", null],
    ])("PUT with %s is 400 and stores nothing", async (_label, body) => {
      const res = await put(h.fetch, "proj", body);
      expect(res.status).toBe(400);
      expect(await h.store.getEnv("proj")).toEqual({});
      expect(await h.secrets.get(projectEnvSecretName(studioScope(OWNER), "proj"))).toBeNull();
      expect(schedulePreviewMock).not.toHaveBeenCalled();
    });

    test("PUT with a body that is not JSON is 400", async () => {
      const res = await h.fetch(secretPath("proj"), {
        method: "PUT",
        headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await h.store.getEnv("proj")).toEqual({});
    });

    test("a name that only collides with Object.prototype stays a plain name", async () => {
      // `constructor` passes the name regex; it must be stored as an own key,
      // not resolve to (or overwrite) anything inherited.
      const res = await put(h.fetch, "proj", { constructor: VALUE });
      expect(res.status).toBe(200);
      expect(await h.store.getEnv("proj")).toEqual({ constructor: VALUE });
      expect(({} as Record<string, unknown>).constructor).toBe(Object);
    });

    test("DELETE with an invalid key name is 400 and changes nothing", async () => {
      await put(h.fetch, "proj", { A: VALUE });
      schedulePreviewMock.mockClear();
      expect((await del(h.fetch, "proj", "BAD-NAME")).status).toBe(400);
      expect(await h.store.getEnv("proj")).toEqual({ A: VALUE });
      expect(schedulePreviewMock).not.toHaveBeenCalled();
    });

    test("an invalid project name is 400 before any store is read", async () => {
      expect((await get(h.fetch, "Not_A_Project!")).status).toBe(400);
      expect((await put(h.fetch, "Not_A_Project!", { A: VALUE })).status).toBe(400);
    });
  });

  /**
   * KNOWN BUG — the size cap is enforced in the wrong place, AFTER the project
   * record is written.
   *
   * `SecretUpdatesSchema` (aai-server/schemas.ts) caps neither a value nor the
   * number of names, and the studio app mounts no `bodyLimit`. The only cap is
   * `MAX_ENV_SIZE` (64 KiB) inside the bundle store's `writeEnv`, which throws
   * a plain Error. `mutateProjectSecrets` writes the project's Vault record
   * FIRST and only then fans out to the agents, so an over-limit PUT:
   *
   * 1. answers 500 instead of a 4xx naming the limit;
   * 2. has already stored the oversized value in the project record, which
   *    nothing rolls back;
   * 3. is accepted outright (200) on a project that has deployed nothing yet.
   *
   * From then on every deploy's `reconcileProjectSecrets` merges that record,
   * trips the same cap and throws — which `createAfterDeploy` swallows by
   * design — so NONE of the project's secrets (not just the oversized one)
   * reach a newly claimed slug, silently. Remove each `.fails` as a fix lands.
   */
  describe("over the 64 KiB env cap", () => {
    const HUGE = "x".repeat(70 * 1024);

    test.fails("a PUT on a deployed project answers 4xx, not 500", async () => {
      const res = await put(h.fetch, "proj", { A: HUGE });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    test.fails("a refused PUT leaves the project record as it was", async () => {
      await put(h.fetch, "proj", { KEEP: "k" });
      await put(h.fetch, "proj", { A: HUGE });
      const record = await h.secrets.get(projectEnvSecretName(studioScope(OWNER), "proj"));
      expect(JSON.parse(record ?? "{}")).toEqual({ KEEP: "k" });
    });

    test.fails("a PUT on a project with no agents yet is refused too", async () => {
      expect((await createProject(h.fetch, "fresh")).status).toBe(201);
      const res = await put(h.fetch, "fresh", { A: HUGE });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("the failure echoes no value, in the response or the logs", async () => {
      const marked = `${VALUE}${HUGE}`;
      const res = await put(h.fetch, "proj", { A: marked });
      expect(await res.text()).not.toContain(VALUE);
      expect(JSON.stringify(logs.all())).not.toContain(VALUE);
    });
  });

  describe("unknown projects", () => {
    test.each([
      ["GET", () => get(h.fetch, "ghost")],
      ["PUT", () => put(h.fetch, "ghost", { A: VALUE })],
      ["DELETE", () => del(h.fetch, "ghost", "A")],
    ])("%s is 404 and leaves no record behind", async (_method, call) => {
      const res = await call();
      expect(res.status).toBe(404);
      expect(await h.secrets.get(projectEnvSecretName(studioScope(OWNER), "ghost"))).toBeNull();
      expect(schedulePreviewMock).not.toHaveBeenCalled();
    });
  });
});

describe("browser sessions", () => {
  test("a session and the key it onboarded share one namespace; a stranger's key does not", async () => {
    const h = await withFakedDevAuth();
    const bearer = devToken("a@b.c");
    expect((await onboardKey(h.fetch, bearer, "users-own-key")).status).toBe(200);
    expect((await createProject(h.fetch, "mine", bearer)).status).toBe(201);

    expect((await put(h.fetch, "mine", { A: VALUE }, bearer)).status).toBe(200);
    const viaKey = (await (await get(h.fetch, "mine", "users-own-key")).json()) as State;
    expect(viaKey.vars).toEqual(["A"]);
    expect((await get(h.fetch, "mine", STRANGER)).status).toBe(404);
  });

  test("a session that has not onboarded a key is refused", async () => {
    const h = await withFakedDevAuth();
    expect((await get(h.fetch, "mine", devToken("new@b.c"))).status).toBe(401);
  });
});
