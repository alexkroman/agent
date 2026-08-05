// Copyright 2025 the AAI authors. MIT license.
// Studio HTTP surface, exercised through the full orchestrator (routing
// order vs the /:slug routes matters and is covered here).

import { authFetch, deployAgent, type TestFetch } from "aai-server/test-utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";
import { requestPublicOrigin } from "./studio-context.ts";
import type { StudioDeployResult } from "./studio-deploy.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { mutateWorkspace, studioScope } from "./studio-workspace.ts";

const deployMock = vi.fn(
  async (..._args: unknown[]): Promise<StudioDeployResult> => ({
    ok: true,
    slug: "proj",
    url: "/proj/",
    output: "Deployed /proj/",
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
const ensureSessionMock = vi.fn(
  async (_scope: string, project: string, _apiKey: string, _serverUrl?: string) =>
    project === "ghost"
      ? null
      : { url: "https://tunnel.example/studio/chat", token: "chat-token-1" },
);
const deployWorkspaceMock = vi.fn(
  async (
    _scope: string,
    _project: string,
    _files: Record<string, string>,
    _target: { serverUrl: string; apiKey: string; slug?: string | undefined },
  ) => ({
    ok: true,
    slug: "p",
    url: "https://platform.example/p",
    output: "Deployed https://platform.example/p",
  }),
);
const schedulePreviewMock = vi.fn();
const refreshSessionMock = vi.fn(
  async (..._args: Parameters<StudioSessionBroker["refreshSession"]>) => true,
);
const brokerMock = vi.fn(
  (): StudioSessionBroker => ({
    ensureSession: (...args: Parameters<StudioSessionBroker["ensureSession"]>) =>
      ensureSessionMock(...args),
    refreshSession: (...args: Parameters<StudioSessionBroker["refreshSession"]>) =>
      refreshSessionMock(...args),
    schedulePreview: (...args: Parameters<StudioSessionBroker["schedulePreview"]>) =>
      schedulePreviewMock(...args),
    deployWorkspace: (...args: Parameters<StudioSessionBroker["deployWorkspace"]>) =>
      deployWorkspaceMock(...args),
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

// Preview wake-up: observable fake so the session route's wiring is
// asserted without real HTTP (behavior lives in studio-preview.test.ts).
const wakePreviewMock = vi.fn();
vi.mock("./studio-preview.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-preview.ts")>();
  return { ...original, wakeProjectPreview: (...args: unknown[]) => wakePreviewMock(...args) };
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

  test("GET /studio/chat/<project> serves the shell (v0-style project URLs)", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/studio/chat/contact-form-x7k2mq");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
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
      model: "gpt-5.5",
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
      model: "gpt-5.5",
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

  test("create starts an EMPTY project and duplicate returns 409", async () => {
    // No starter agent: the coding agent's first turn goes into the user's
    // agent rather than into dismantling a dice roller (studio-template.ts).
    const res = await createProject(fetch);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { files: Record<string, string> };
    expect(Object.keys(body.files)).toEqual([]);
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

  test("create with a prompt generates a v0-style name (base + suffix)", async () => {
    // The chat-first flow: the client sends the first message, the SERVER
    // names the project — same generator as slugless CLI deploys.
    const res = await authFetch(fetch, "/studio/projects", {
      body: { prompt: "Build me a contact form agent for my site" },
    });
    expect(res.status).toBe(201);
    const { name } = (await res.json()) as { name: string };
    expect(name).toMatch(/^contact-form(-[a-z0-9-]+)?-[a-z0-9]{6}$/);
    // Addressable like any other project.
    expect((await authFetch(fetch, `/studio/projects/${name}`, { method: "GET" })).status).toBe(
      200,
    );
  });

  test("create with the same prompt twice yields two distinct projects", async () => {
    const make = async () => {
      const res = await authFetch(fetch, "/studio/projects", {
        body: { prompt: "pizza ordering" },
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { name: string }).name;
    };
    expect(await make()).not.toBe(await make());
  });

  test("create with no name and no prompt still generates a name", async () => {
    const res = await authFetch(fetch, "/studio/projects", { body: {} });
    expect(res.status).toBe(201);
    const { name } = (await res.json()) as { name: string };
    expect(name).toMatch(/-[a-z0-9]{6}$/);
  });

  test("get returns the project's files; 404 when missing", async () => {
    await createProject(fetch);
    await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "agent.ts", content: "export default {};" },
    });
    const res = await authFetch(fetch, "/studio/projects/proj", { method: "GET" });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as { files: Record<string, string> }).files)).toContain(
      "agent.ts",
    );
    expect((await authFetch(fetch, "/studio/projects/ghost", { method: "GET" })).status).toBe(404);
  });

  test("file write, delete, and delete-missing behave", async () => {
    schedulePreviewMock.mockClear();
    await createProject(fetch);
    const put = await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "extra.ts", content: "export {};" },
    });
    expect(put.status).toBe(200);
    // A manual save is a settled edit — it schedules an auto preview deploy
    // with the caller's key and the public origin the guest's CLI dials.
    expect(schedulePreviewMock).toHaveBeenCalledWith(
      studioScope("key1"),
      "proj",
      expect.objectContaining({ apiKey: "key1", serverUrl: expect.stringMatching(/^https?:/) }),
    );
    const files = (
      (await (await authFetch(fetch, "/studio/projects/proj", { method: "GET" })).json()) as {
        files: Record<string, string>;
      }
    ).files;
    expect(files["extra.ts"]).toBe("export {};");

    schedulePreviewMock.mockClear();
    const del = await authFetch(fetch, "/studio/projects/proj/file?path=extra.ts", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(schedulePreviewMock).toHaveBeenCalledTimes(1);
    schedulePreviewMock.mockClear();
    expect(
      (await authFetch(fetch, "/studio/projects/proj/file?path=extra.ts", { method: "DELETE" }))
        .status,
    ).toBe(404);
    // A rejected delete is not an edit — nothing to preview.
    expect(schedulePreviewMock).not.toHaveBeenCalled();
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

  test("delete project cascades to its deployed agents — owned ones only", async () => {
    const combined = await createTestCombined();
    // The agents Publish and the preview auto-deploy would have created.
    await deployAgent(combined.fetch, "proj", "key1");
    await deployAgent(combined.fetch, "proj-preview", "key1");
    // A slug the caller does NOT own: the workspace naming it must not
    // become a deletion oracle.
    await deployAgent(combined.fetch, "someone-elses", "key2");
    await createProject(combined.fetch);
    // Stamp the deploy metadata the way Publish/preview do.
    await mutateWorkspace(combined.workspaces, studioScope("key1"), "proj", (current) => ({
      ...current,
      deployedSlug: "proj",
      previewSlug: "proj-preview",
    }));
    await mutateWorkspace(combined.workspaces, studioScope("key1"), "proj", (current) => ({
      ...current,
      deployedSlug: "someone-elses",
    }));

    const res = await authFetch(combined.fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(res.status).toBe(200);
    // The preview agent (owned) is gone; the foreign slug survives.
    expect(await combined.store.getAgent("proj-preview")).toBeNull();
    expect(await combined.store.getAgent("someone-elses")).not.toBeNull();
    expect(await combined.store.getAgent("proj")).not.toBeNull();
  });

  // The `aai push` surface; fast-forward/no-op/metadata semantics are unit
  // tested in studio-workspace.test.ts — this covers the route wiring.
  test("source sync: first push creates, stale baseHash 409s, no-op skips preview", async () => {
    schedulePreviewMock.mockClear();
    refreshSessionMock.mockClear();
    const push = (body: unknown) =>
      authFetch(fetch, "/studio/projects/pushed/source", { method: "PUT", body });
    const created = await push({ files: { "agent.ts": "export {};" } });
    expect(created.status).toBe(201);
    const { sourceHash } = (await created.json()) as { sourceHash: string };
    expect(schedulePreviewMock).toHaveBeenCalledTimes(1);
    // A push edits the workspace from OUTSIDE the studio, so the project's
    // live coding-agent sandbox has to be re-installed with the pushed tree —
    // otherwise its next end-of-turn sync writes the pre-push files back.
    expect(refreshSessionMock).toHaveBeenCalledWith(studioScope("key1"), "pushed", "key1");
    // GET returns the same fast-forward token the push did.
    const got = (await (
      await authFetch(fetch, "/studio/projects/pushed", { method: "GET" })
    ).json()) as { files: Record<string, string>; sourceHash: string };
    expect(got.sourceHash).toBe(sourceHash);
    expect(got.files["agent.ts"]).toBe("export {};");

    // Identical files: accepted, but nothing changed — no preview churn, and
    // no reason to reinstall a session already holding these exact files.
    schedulePreviewMock.mockClear();
    refreshSessionMock.mockClear();
    const noop = await push({ files: { "agent.ts": "export {};" }, baseHash: sourceHash });
    expect(noop.status).toBe(200);
    expect(schedulePreviewMock).not.toHaveBeenCalled();
    expect(refreshSessionMock).not.toHaveBeenCalled();

    // A stale token (the studio edited since the pull) is a 409, not a stomp.
    const stale = await push({ files: { "agent.ts": "changed" }, baseHash: "not-the-hash" });
    expect(stale.status).toBe(409);
    // The current token fast-forwards.
    expect((await push({ files: { "agent.ts": "changed" }, baseHash: sourceHash })).status).toBe(
      200,
    );
  });

  test("source sync rejects reserved names and traversal paths", async () => {
    expect(
      (
        await authFetch(fetch, "/studio/projects/studio/source", {
          method: "PUT",
          body: { files: {} },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await authFetch(fetch, "/studio/projects/proj2/source", {
          method: "PUT",
          body: { files: { "../evil.ts": "x" } },
        })
      ).status,
    ).toBe(400);
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

  test("deploy route runs the pipeline and returns the URL + CLI output", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/deploy", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      slug: "proj",
      url: "/proj/",
      output: "Deployed /proj/",
    });
    const [, params] = deployMock.mock.calls[0] as unknown[] as [
      unknown,
      { apiKey: string; project: string; serverUrl: string },
    ];
    expect(params).toMatchObject({
      apiKey: "key1",
      project: "proj",
      // Combined/dev: the request URL's own origin is the public origin the
      // guest's `aai deploy` dials.
      serverUrl: expect.stringMatching(/^https?:\/\//),
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
    expect(await res.json()).toEqual({
      url: "https://tunnel.example/studio/chat",
      token: "chat-token-1",
    });
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

// Landing on a project (the once-per-open session broker call) wakes its
// preview. The wake's behavior (stale redeploy gates, sandbox warm-up) is
// covered in studio-preview.test.ts — this asserts the route's wiring.
describe("session wakes the preview", () => {
  test("a successful session broker call wakes the project's preview", async () => {
    wakePreviewMock.mockClear();
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/session", { body: {} });
    expect(res.status).toBe(200);
    expect(wakePreviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: studioScope("key1"),
        project: "proj",
        target: expect.objectContaining({
          apiKey: "key1",
          serverUrl: expect.stringMatching(/^https?:/),
        }),
        schedule: expect.any(Function),
      }),
    );
    // A missing project never wakes anything.
    wakePreviewMock.mockClear();
    await authFetch(fetch, "/studio/projects/ghost/session", { body: {} });
    expect(wakePreviewMock).not.toHaveBeenCalled();
  });
});

describe("requestPublicOrigin", () => {
  /** A request as the studio sees it behind Modal: cleartext, public Host. */
  const behindTls = (headers: Record<string, string> = {}) =>
    ({
      req: {
        raw: new Request("http://agent.example.modal.run/studio/projects/p/deploy", { headers }),
      },
    }) as unknown as Parameters<typeof requestPublicOrigin>[0];

  test("publishes https for a public host behind a TLS-terminating proxy", () => {
    // Publish hands this origin to the guest's `aai deploy`. Resolving it as
    // http:// made the platform 308-redirect the deploy POST to https, which
    // strips Authorization across the scheme change — every Publish 401'd.
    expect(requestPublicOrigin(behindTls(), {})).toBe("https://agent.example.modal.run");
  });

  test("honors the agent service's forwarded headers in split mode", () => {
    const origin = requestPublicOrigin(
      behindTls({ "x-forwarded-host": "public.example", "x-forwarded-proto": "https" }),
      {},
    );
    expect(origin).toBe("https://public.example");
  });

  test("AAI_PUBLIC_ORIGIN still wins", () => {
    expect(requestPublicOrigin(behindTls(), { AAI_PUBLIC_ORIGIN: "https://aai.example/" })).toBe(
      "https://aai.example",
    );
  });
});
