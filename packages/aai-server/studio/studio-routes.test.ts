// Copyright 2025 the AAI authors. MIT license.
// Studio HTTP surface, exercised through the full orchestrator (routing
// order vs the /:slug routes matters and is covered here).

import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HonoEnv } from "../context.ts";
import { createMemorySecretStore } from "../secret-store.ts";
import { authFetch, authHeaders, createTestOrchestrator, type TestFetch } from "../test-utils.ts";
import { createMemoryChatStore } from "./chat-store.ts";
import type { StudioDeployResult } from "./studio-deploy.ts";
import { createStudioRoutes } from "./studio-routes.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
import { createWorkspace, studioScope } from "./studio-workspace.ts";
import { createMemoryWorkspaceStore } from "./workspace-store.ts";

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

// Chat: replace the LLM loop with a fixed SSE response so the route's
// gating/wiring is exercised without a model or sandbox.
const chatMock = vi.fn(
  async (..._args: unknown[]): Promise<Response> =>
    new Response('data: {"type":"start"}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    }),
);
vi.mock("./studio-agent.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-agent.ts")>();
  return { ...original, runStudioChat: (...args: unknown[]) => chatMock(...args) };
});

function createProject(fetch: TestFetch, name = "proj", key = "key1"): Promise<Response> {
  return authFetch(fetch, "/studio/projects", { body: { name }, key });
}

function chatBody(project = "proj") {
  return {
    project,
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
  };
}

describe("studio page + routing", () => {
  test("GET / serves the studio shell with a strict CSP", async () => {
    const { fetch } = await createTestOrchestrator();
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

  test("GET /studio and /studio/ redirect to the page", async () => {
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio")).status).toBe(302);
    expect((await fetch("/studio/")).status).toBe(302);
  });

  test("studio assets 404 when unknown and 400 on traversal", async () => {
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio-assets/assets/nope.js")).status).toBe(404);
    expect((await fetch("/studio-assets/..%2f..%2fpackage.json")).status).toBe(400);
  });

  test("GET /studio/status is public and reports LLM availability", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/studio/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ llm: false });
  });

  test("status reports the gateway provider/model when configured", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    vi.stubEnv("STUDIO_LLM_MODEL", "");
    const { fetch } = await createTestOrchestrator();
    expect(await (await fetch("/studio/status")).json()).toEqual({
      llm: true,
      provider: "assemblyai",
      model: "gpt-5.5",
    });
  });

  test("studio slugs are reserved: agent routes 404 and deploys reject them", async () => {
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio/websocket")).status).toBe(404);
    for (const slug of ["studio", "studio-assets"]) {
      const res = await authFetch(fetch, "/deploy", {
        body: {
          slug,
          worker: "export default {}",
          clientFiles: {},
          agentConfig: { name: "x", systemPrompt: "s", toolSchemas: [], allowedHosts: [] },
        },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("studio auth", () => {
  test("project routes require a bearer key", async () => {
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio/projects")).status).toBe(401);
    expect((await fetch("/studio/projects/x", { method: "DELETE" })).status).toBe(401);
    expect((await fetch("/studio/chat", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("workspaces are namespaced per key", async () => {
    const { fetch } = await createTestOrchestrator();
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
    ({ fetch } = await createTestOrchestrator());
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
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio/projects/proj/chat")).status).toBe(401);
    expect((await authFetch(fetch, "/studio/projects/ghost/chat", { method: "GET" })).status).toBe(
      404,
    );
  });

  test("a project with no chat yet returns an empty message list", async () => {
    const { fetch } = await createTestOrchestrator();
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  test("a persisted conversation round-trips through the route", async () => {
    const { fetch, chats } = await createTestOrchestrator();
    await createProject(fetch);
    await chats.putChat(studioScope("key1"), "proj", HISTORY);
    const res = await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET" });
    expect(await res.json()).toEqual({ messages: HISTORY });
  });

  test("chats are namespaced per key — another key's project 404s", async () => {
    const { fetch, chats } = await createTestOrchestrator();
    await createProject(fetch);
    await chats.putChat(studioScope("key1"), "proj", HISTORY);
    expect(
      (await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET", key: "key2" })).status,
    ).toBe(404);
  });

  test("deleting the project deletes its chat row too", async () => {
    const { fetch, chats } = await createTestOrchestrator();
    await createProject(fetch);
    const scope = studioScope("key1");
    await chats.putChat(scope, "proj", HISTORY);
    await authFetch(fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(await chats.getChat(scope, "proj")).toBeNull();
  });

  test("the chat route hands runStudioChat a persist hook writing to the chat store", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("STUDIO_MCP_URLS", "");
    chatMock.mockClear();
    const { fetch, chats } = await createTestOrchestrator();
    await createProject(fetch);
    await authFetch(fetch, "/studio/chat", { body: chatBody() });
    const [deps] = chatMock.mock.calls[0] as unknown[] as [
      { persistMessages: (messages: unknown[]) => Promise<void> },
    ];
    expect(typeof deps.persistMessages).toBe("function");
    await deps.persistMessages(HISTORY);
    expect(await chats.getChat(studioScope("key1"), "proj")).toEqual(HISTORY);
  });
});

describe("deploy + chat endpoints", () => {
  let fetch: TestFetch;
  beforeEach(async () => {
    deployMock.mockClear();
    chatMock.mockClear();
    // The chat route starts the MCP connect itself (to overlap it with the
    // workspace fetch); disable it so route tests never touch the network.
    vi.stubEnv("STUDIO_MCP_URLS", "");
    ({ fetch } = await createTestOrchestrator());
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

  test("chat returns 503 when the LLM is not configured", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", { body: chatBody() });
    expect(res.status).toBe(503);
  });

  test("chat 404s for a missing project before touching the LLM", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const res = await authFetch(fetch, "/studio/chat", { body: chatBody("ghost") });
    expect(res.status).toBe(404);
    expect(chatMock).not.toHaveBeenCalled();
  });

  test("chat validates the body (empty messages, missing ids)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const empty = await authFetch(fetch, "/studio/chat", {
      body: { project: "proj", messages: [] },
    });
    expect(empty.status).toBe(400);
    const noId = await authFetch(fetch, "/studio/chat", {
      body: { project: "proj", messages: [{ role: "user", parts: [] }] },
    });
    expect(noId.status).toBe(400);
  });

  test("chat rejects an oversized raw body before parsing it", async () => {
    // The aggregate cap is enforced on raw text length — no JSON.parse, no
    // zod, no re-stringify of a 4MB body.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const padding = "x".repeat(4_000_001);
    const res = await authFetch(fetch, "/studio/chat", {
      body: { ...chatBody(), padding },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("too large");
    expect(chatMock).not.toHaveBeenCalled();
  });

  test("chat rejects malformed JSON with a 400", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const res = await fetch("/studio/chat", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(chatMock).not.toHaveBeenCalled();
  });

  test("chat rejects a single message over the per-message content cap", async () => {
    // Per-message size is summed string content, not a per-message
    // JSON.stringify — same effective limit, no re-serialization.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", {
      body: {
        project: "proj",
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "y".repeat(600_001) }] },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(chatMock).not.toHaveBeenCalled();
  });

  test("chat streams the UI message stream from runStudioChat", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", { body: chatBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"type":"start"');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [deps, messages] = chatMock.mock.calls[0] as unknown[] as [
      { project: string; sandbox: unknown; disposeSandbox: unknown },
      { role: string }[],
    ];
    expect(deps.project).toBe("proj");
    expect(typeof deps.sandbox).toBe("function");
    expect(typeof deps.disposeSandbox).toBe("function");
    expect(messages).toHaveLength(1);
  });

  test("chat always runs on the host default model — no per-request choice", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    await createProject(fetch);
    // A stray `model` field is ignored (stripped by the body schema), never
    // honored: the host default is the only model the chat route runs.
    const res = await authFetch(fetch, "/studio/chat", {
      body: { ...chatBody(), model: "claude-opus-4-7" },
    });
    expect(res.status).toBe(200);
    const [deps] = chatMock.mock.calls[0] as unknown[] as [{ model?: unknown }];
    expect(deps.model).toBeUndefined();
  });

  test("chat is rate limited per scope with a Retry-After", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    for (let i = 0; i < 30; i += 1) {
      expect((await authFetch(fetch, "/studio/chat", { body: chatBody() })).status).toBe(200);
    }
    const limited = await authFetch(fetch, "/studio/chat", { body: chatBody() });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toContain("Rate limit");
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    // Another scope is unaffected (its project doesn't exist → 404, not 429).
    expect((await authFetch(fetch, "/studio/chat", { body: chatBody(), key: "key2" })).status).toBe(
      404,
    );
  });

  test("project creation is rate limited per scope", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await createProject(fetch, `proj-${i}`)).status).toBe(201);
    }
    const limited = await createProject(fetch, "one-too-many");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  test("a client-supplied provider/model is ignored — the host config decides", async () => {
    // Nothing about the LLM is negotiable: a hand-crafted request naming a
    // provider and model is stripped by the body schema and the turn runs on
    // the host-configured default.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    vi.stubEnv("STUDIO_LLM_MODEL", "");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", {
      body: { ...chatBody(), provider: "assemblyai", model: "gpt-4.1" },
    });
    expect(res.status).toBe(200);
    const [deps] = chatMock.mock.calls[0] as unknown[] as [
      Record<string, unknown> & { model?: unknown },
    ];
    expect(deps).not.toHaveProperty("llm");
    expect(deps.model).toBeUndefined();
  });
});

describe("chat sandbox lifecycle", () => {
  type ChatDeps = {
    sandbox: () => Promise<StudioSandbox>;
    disposeSandbox: () => Promise<void>;
  };

  /** Studio routes with an observable fake sandbox factory, plus one project. */
  async function chatApp() {
    vi.stubEnv("STUDIO_MCP_URLS", "");
    const dispose = vi.fn(async (): Promise<void> => undefined);
    const createSandbox = vi.fn(
      async (): Promise<StudioSandbox> => ({
        loadBundle: async () => ({}),
        executeTool: async () => "ok",
        dispose,
      }),
    );
    const workspaces = createMemoryWorkspaceStore();
    await createWorkspace(workspaces, studioScope("key1"), "proj", { files: { "agent.ts": "x" } });
    const app = new Hono<HonoEnv>().route(
      "/studio",
      createStudioRoutes({ createSandbox, llmConfigured: () => true }),
    );
    const bindings = {
      workspaces,
      chats: createMemoryChatStore(),
    } as unknown as HonoEnv["Bindings"];
    const request = () =>
      app.request(
        "/studio/chat",
        { method: "POST", headers: authHeaders(), body: JSON.stringify(chatBody()) },
        bindings,
      );
    return { request, createSandbox, dispose };
  }

  beforeEach(() => {
    chatMock.mockClear();
  });

  test("a dispose that ran before lazy provisioning blocks it — no leaked sandbox", async () => {
    // The abort race: runStudioChat's teardown fires while sandboxPromise is
    // still null (test_agent is mid Vite build), then the tool asks for the
    // sandbox. Provisioning one now would leak a Modal sandbox nothing
    // ever disposes.
    const { request, createSandbox } = await chatApp();
    expect((await request()).status).toBe(200);
    const [deps] = chatMock.mock.calls[0] as unknown[] as [ChatDeps];

    await deps.disposeSandbox();
    await expect(deps.sandbox()).rejects.toThrow(/turn ended/);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  test("a failed provisioning is retried, not cached for the rest of the turn", async () => {
    // `??=` used to pin the first rejection: one transient spawn failure made
    // every later test_agent call answer "Sandbox unavailable".
    const { request, createSandbox } = await chatApp();
    createSandbox.mockRejectedValueOnce(new Error("spawn failed"));
    expect((await request()).status).toBe(200);
    const [deps] = chatMock.mock.calls[0] as unknown[] as [ChatDeps];

    await expect(deps.sandbox()).rejects.toThrow("spawn failed");
    await expect(deps.sandbox()).resolves.toBeDefined();
    expect(createSandbox).toHaveBeenCalledTimes(2);
  });

  test("a sandbox provisioned before dispose is disposed exactly once", async () => {
    const { request, createSandbox, dispose } = await chatApp();
    expect((await request()).status).toBe(200);
    const [deps] = chatMock.mock.calls[0] as unknown[] as [ChatDeps];

    await deps.sandbox();
    // Repeat calls reuse the one sandbox.
    await deps.sandbox();
    expect(createSandbox).toHaveBeenCalledTimes(1);
    await deps.disposeSandbox();
    expect(dispose).toHaveBeenCalledTimes(1);
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
    const { fetch, workspaces } = await createTestOrchestrator({ secrets, appDb });
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
    const { fetch, workspaces } = await createTestOrchestrator({ secrets });
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
