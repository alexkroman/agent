// Copyright 2025 the AAI authors. MIT license.
// Studio HTTP surface, exercised through the full orchestrator (routing
// order vs the /:slug routes matters and is covered here).

import { createMemorySecretStore } from "aai-server/secret-store";
import { authFetch, authHeaders, type TestFetch } from "aai-server/test-utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";
import type { StudioDeployResult } from "./studio-deploy.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { createWorkspace, studioScope } from "./studio-workspace.ts";

const deployMock = vi.fn(
  async (..._args: unknown[]): Promise<StudioDeployResult> => ({
    ok: true,
    slug: "proj",
    url: "/proj/",
  }),
);

// The orchestrator constructs its studio routes internally; intercept the
// deploy pipeline at the module boundary so no bundler/sandbox runs here.
vi.mock("./studio-deploy.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-deploy.ts")>();
  return { ...original, deployStudioProject: (...args: unknown[]) => deployMock(...args) };
});

// Session broker: replace sandbox provisioning with an observable fake so
// the route's gating/wiring is exercised without Modal.
const ensureSessionMock = vi.fn(async (_scope: string, project: string, _apiKey: string) =>
  project === "ghost" ? null : { url: "https://tunnel.example/studio/chat" },
);
const brokerMock = vi.fn(
  (): StudioSessionBroker => ({
    ensureSession: (...args: Parameters<StudioSessionBroker["ensureSession"]>) =>
      ensureSessionMock(...args),
    dispose: async () => undefined,
  }),
);
vi.mock("./studio-session-broker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-session-broker.ts")>();
  return {
    ...original,
    createStudioSessionBroker: (...args: unknown[]) => brokerMock(...(args as [])),
  };
});

function createProject(fetch: TestFetch, name = "proj", key = "key1"): Promise<Response> {
  return authFetch(fetch, "/studio/projects", { body: { name }, key });
}

describe("studio page + routing", () => {
  test("GET / serves the studio shell with a strict CSP", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    // The shell is either the built client (whatever dist/studio-client holds
    // — its content is a build artifact, possibly stale in dev checkouts) or
    // the not-built fallback. Assert only the invariants shared by both;
    // asserting on branding text made this test race the client build.
    expect(await res.text()).toContain("<!DOCTYPE html>");
  });

  test("GET /favicon.ico serves the studio icon when built, else 404", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/favicon.ico");
    // The icon ships inside the studio client build, which dev checkouts may
    // not have run — assert the two valid outcomes (never a 500, and never a
    // match on the agent slug routes).
    if (res.status === 200) {
      expect(res.headers.get("Content-Type")).toBe("image/x-icon");
    } else {
      expect(res.status).toBe(404);
    }
  });

  test("GET /studio and /studio/ redirect to the page", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio")).status).toBe(302);
    expect((await fetch("/studio/")).status).toBe(302);
  });

  test("studio assets 404 when unknown and 400 on traversal", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio-assets/assets/nope.js")).status).toBe(404);
    expect((await fetch("/studio-assets/..%2f..%2fpackage.json")).status).toBe(400);
  });

  test("GET /studio/status is public and reports the caller-keyed LLM", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/studio/status");
    expect(res.status).toBe(200);
    // Chat always runs — on the caller's own key — so llm is always true.
    expect(await res.json()).toEqual({
      llm: true,
      provider: "assemblyai",
      model: "qwen3-next-80b-a3b",
    });
  });

  test("status reports the gateway provider/model when configured", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    vi.stubEnv("STUDIO_LLM_MODEL", "");
    const { fetch } = await createTestCombined();
    expect(await (await fetch("/studio/status")).json()).toEqual({
      llm: true,
      provider: "assemblyai",
      model: "qwen3-next-80b-a3b",
    });
  });

  test("studio slugs are reserved: agent routes 404 and deploys reject them", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/websocket")).status).toBe(404);
    for (const slug of ["studio", "studio-assets"]) {
      const res = await authFetch(fetch, "/deploy", {
        body: {
          slug,
          worker: "export default {}",
          clientFiles: {},
          agentConfig: { name: "x", systemPrompt: "s", toolSchemas: [] },
        },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("studio auth", () => {
  test("project routes require a bearer key", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/projects")).status).toBe(401);
    expect((await fetch("/studio/projects/x", { method: "DELETE" })).status).toBe(401);
    expect((await fetch("/studio/chat", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("workspaces are namespaced per key", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch, "mine", "key1");
    const mine = (await (await authFetch(fetch, "/studio/projects", { method: "GET" })).json()) as {
      projects: string[];
    };
    expect(mine.projects).toEqual(["mine"]);
    const theirs = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: "key2" })
    ).json()) as { projects: string[] };
    expect(theirs.projects).toEqual([]);
  });
});

describe("project CRUD", () => {
  let fetch: TestFetch;
  beforeEach(async () => {
    ({ fetch } = await createTestCombined());
  });

  test("create returns starter files and duplicate returns 409", async () => {
    const res = await createProject(fetch);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { files: Record<string, string> };
    expect(body.files["agent.ts"]).toContain("export default agent(");
    expect((await createProject(fetch)).status).toBe(409);
  });

  test("create slugifies a human-typed name", async () => {
    // A project name doubles as the deploy slug, but people type "My Agent".
    const res = await authFetch(fetch, "/studio/projects", { body: { name: "My Agent" } });
    expect(res.status).toBe(201);
    expect((await res.json()) as { name: string }).toMatchObject({ name: "my-agent" });
    // The slug is what everything downstream addresses it by.
    expect((await authFetch(fetch, "/studio/projects/my-agent", { method: "GET" })).status).toBe(
      200,
    );
  });

  test.each([
    ["  Spaced  Out  ", "spaced-out"],
    ["Pizza Bot 3000!", "pizza-bot-3000"],
    // Transliterated, not stripped — this is why slugify beats a regex.
    ["Café Ordering", "cafe-ordering"],
    ["already-a-slug", "already-a-slug"],
    // slugify normalizes "_" to "-"; both are valid slugs, "-" reads better in a URL.
    ["UPPER_CASE", "upper-case"],
  ])("create normalizes %j to %j", async (input, expected) => {
    const res = await authFetch(fetch, "/studio/projects", { body: { name: input } });
    expect(res.status).toBe(201);
    expect((await res.json()) as { name: string }).toMatchObject({ name: expected });
  });

  test("create rejects names that slugify to nothing", async () => {
    for (const name of ["!!!", "   ", "-", "…"]) {
      expect((await authFetch(fetch, "/studio/projects", { body: { name } })).status).toBe(400);
    }
  });

  test("create rejects a name that would claim a reserved slug", async () => {
    // Better to fail here than to let the project exist and die at publish.
    const res = await authFetch(fetch, "/studio/projects", { body: { name: "Studio" } });
    expect(res.status).toBe(400);
  });

  test("get returns files; 404 when missing", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj", { method: "GET" });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as { files: Record<string, string> }).files)).toContain(
      "agent.ts",
    );
    expect((await authFetch(fetch, "/studio/projects/ghost", { method: "GET" })).status).toBe(404);
  });

  test("file write, delete, and delete-missing behave", async () => {
    await createProject(fetch);
    const put = await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "extra.ts", content: "export {};" },
    });
    expect(put.status).toBe(200);
    const files = (
      (await (await authFetch(fetch, "/studio/projects/proj", { method: "GET" })).json()) as {
        files: Record<string, string>;
      }
    ).files;
    expect(files["extra.ts"]).toBe("export {};");

    const del = await authFetch(fetch, "/studio/projects/proj/file?path=extra.ts", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(
      (await authFetch(fetch, "/studio/projects/proj/file?path=extra.ts", { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (await authFetch(fetch, "/studio/projects/proj/file", { method: "DELETE" })).status,
    ).toBe(400);
  });

  test("concurrent creates: one wins, the loser cannot reset the files", async () => {
    const [a, b] = await Promise.all([createProject(fetch), createProject(fetch)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  test("concurrent file writes both survive", async () => {
    await createProject(fetch);
    const put = (path: string, content: string) =>
      authFetch(fetch, "/studio/projects/proj/file", { method: "PUT", body: { path, content } });
    await Promise.all([put("a.ts", "a"), put("b.ts", "b")]);
    const { files } = (await (
      await authFetch(fetch, "/studio/projects/proj", { method: "GET" })
    ).json()) as { files: Record<string, string> };
    expect(files["a.ts"]).toBe("a");
    expect(files["b.ts"]).toBe("b");
  });

  test("file write rejects traversal paths", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "../evil.ts", content: "x" },
    });
    expect(res.status).toBe(400);
  });

  test("delete project removes it from the list", async () => {
    await createProject(fetch);
    await authFetch(fetch, "/studio/projects/proj", { method: "DELETE" });
    const list = (await (await authFetch(fetch, "/studio/projects", { method: "GET" })).json()) as {
      projects: string[];
    };
    expect(list.projects).toEqual([]);
  });
});

describe("chat history routes", () => {
  const HISTORY = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }] },
  ];

  test("GET chat is bearer-auth'd and 404s for a missing project", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/projects/proj/chat")).status).toBe(401);
    expect((await authFetch(fetch, "/studio/projects/ghost/chat", { method: "GET" })).status).toBe(
      404,
    );
  });

  test("a project with no chat yet returns an empty message list", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  test("a persisted conversation round-trips through the route", async () => {
    const { fetch, chats } = await createTestCombined();
    await createProject(fetch);
    await chats.putChat(studioScope("key1"), "proj", HISTORY);
    const res = await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET" });
    expect(await res.json()).toEqual({ messages: HISTORY });
  });

  test("chats are namespaced per key — another key's project 404s", async () => {
    const { fetch, chats } = await createTestCombined();
    await createProject(fetch);
    await chats.putChat(studioScope("key1"), "proj", HISTORY);
    expect(
      (await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET", key: "key2" })).status,
    ).toBe(404);
  });

  test("deleting the project deletes its chat row too", async () => {
    const { fetch, chats } = await createTestCombined();
    await createProject(fetch);
    const scope = studioScope("key1");
    await chats.putChat(scope, "proj", HISTORY);
    await authFetch(fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(await chats.getChat(scope, "proj")).toBeNull();
  });
});

describe("deploy + chat endpoints", () => {
  let fetch: TestFetch;
  beforeEach(async () => {
    deployMock.mockClear();
    ensureSessionMock.mockClear();
    ({ fetch } = await createTestCombined());
  });

  test("deploy route runs the pipeline and returns the URL", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/deploy", {
      body: { env: { ASSEMBLYAI_API_KEY: "k" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: "proj", url: "/proj/" });
    const [, params] = deployMock.mock.calls[0] as unknown[] as [
      unknown,
      { apiKey: string; project: string; env?: Record<string, string> },
    ];
    expect(params).toMatchObject({
      apiKey: "key1",
      project: "proj",
      env: { ASSEMBLYAI_API_KEY: "k" },
    });
  });

  test("deploy route surfaces pipeline errors as 400", async () => {
    await createProject(fetch);
    deployMock.mockResolvedValueOnce({ ok: false, error: "Build failed: nope" });
    const res = await authFetch(fetch, "/studio/projects/proj/deploy", { body: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Build failed");
  });

  test("session 404s for a missing project", async () => {
    const res = await authFetch(fetch, "/studio/projects/ghost/session", { body: {} });
    expect(res.status).toBe(404);
  });

  test("session boots the project sandbox and returns its public chat URL", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/session", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://tunnel.example/studio/chat" });
    // The broker got the caller's own key — it becomes the guest's LLM
    // credential and the chat surface's bearer.
    const call = ensureSessionMock.mock.calls.at(-1) as unknown[];
    expect(call[0]).toBe(studioScope("key1"));
    expect(call[1]).toBe("proj");
    expect(call[2]).toBe("key1");
  });

  test("session requires a bearer key", async () => {
    const res = await fetch("/studio/projects/proj/session", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("session is rate limited per scope with a Retry-After", async () => {
    await createProject(fetch);
    for (let i = 0; i < 30; i += 1) {
      expect((await authFetch(fetch, "/studio/projects/proj/session", { body: {} })).status).toBe(
        200,
      );
    }
    const limited = await authFetch(fetch, "/studio/projects/proj/session", { body: {} });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toContain("Rate limit");
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    // Another scope is unaffected: it reaches the broker (404 for a project
    // the fake broker treats as missing) instead of being answered 429.
    expect(
      (await authFetch(fetch, "/studio/projects/ghost/session", { body: {}, key: "key2" })).status,
    ).toBe(404);
  });

  test("project creation is rate limited per scope", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await createProject(fetch, `proj-${i}`)).status).toBe(201);
    }
    const limited = await createProject(fetch, "one-too-many");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });
});

// ── Storage routes (per-app database on the published agent) ─────────────

describe("studio storage routes", () => {
  const META = { role: "app_0123456789abcdef", password: "f" };

  async function storageApp(opts: { deployed?: boolean } = {}) {
    const appDb = {
      provision: vi.fn(async () => META),
      deprovision: vi.fn(async () => undefined),
      open: () => {
        throw new Error("open not expected");
      },
    };
    const secrets = createMemorySecretStore();
    const { fetch, workspaces } = await createTestCombined({ secrets, appDb });
    await createWorkspace(workspaces, studioScope("key1"), "proj", {
      files: { "agent.ts": "x" },
      ...(opts.deployed !== false && { deployedSlug: "proj" }),
    });
    return { fetch, appDb, secrets };
  }

  test("routes are bearer-auth'd", async () => {
    const { fetch } = await storageApp();
    expect((await fetch("/studio/projects/proj/storage")).status).toBe(401);
  });

  test("unknown project → 404, unpublished project → 409", async () => {
    const { fetch } = await storageApp({ deployed: false });
    const missing = await fetch("/studio/projects/nope/storage", { headers: authHeaders() });
    expect(missing.status).toBe(404);

    const unpublished = await fetch("/studio/projects/proj/storage", { headers: authHeaders() });
    expect(unpublished.status).toBe(409);
    expect(await unpublished.json()).toEqual({ error: "Project has not been published yet" });
  });

  test("enable/status/disable round-trip against the published slug", async () => {
    const { fetch, appDb, secrets } = await storageApp();

    const before = await fetch("/studio/projects/proj/storage", { headers: authHeaders() });
    expect(await before.json()).toEqual({ enabled: false });

    const enable = await fetch("/studio/projects/proj/storage", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toEqual({ ok: true, enabled: true });
    expect(appDb.provision).toHaveBeenCalledWith("proj");
    expect(await secrets.get("app-db:proj")).not.toBeNull();

    const after = await fetch("/studio/projects/proj/storage", { headers: authHeaders() });
    expect(await after.json()).toEqual({ enabled: true });

    const disable = await fetch("/studio/projects/proj/storage", {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(await disable.json()).toEqual({ ok: true, enabled: false });
    expect(appDb.deprovision).toHaveBeenCalledWith("proj");
    expect(await secrets.get("app-db:proj")).toBeNull();
  });

  test("enable without SUPABASE_DB_URL configured → 503", async () => {
    const secrets = createMemorySecretStore();
    const { fetch, workspaces } = await createTestCombined({ secrets });
    await createWorkspace(workspaces, studioScope("key1"), "proj", {
      files: { "agent.ts": "x" },
      deployedSlug: "proj",
    });
    const res = await fetch("/studio/projects/proj/storage", {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(503);
  });
});
