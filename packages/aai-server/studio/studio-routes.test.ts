// Copyright 2025 the AAI authors. MIT license.
// Studio HTTP surface, exercised through the full orchestrator (routing
// order vs the /:slug routes matters and is covered here).

import { beforeEach, describe, expect, test, vi } from "vitest";
import { authFetch, createTestOrchestrator, type TestFetch } from "../test-utils.ts";
import type { StudioDeployResult } from "./studio-deploy.ts";

const deployMock = vi.fn(
  async (..._args: unknown[]): Promise<StudioDeployResult> => ({
    ok: true,
    slug: "proj",
    url: "/proj/",
  }),
);

// The orchestrator constructs its studio routes internally; intercept the
// deploy pipeline at the module boundary so no esbuild/sandbox runs here.
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
      model: "gpt-5.2",
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

describe("deploy + chat endpoints", () => {
  let fetch: TestFetch;
  beforeEach(async () => {
    deployMock.mockClear();
    chatMock.mockClear();
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

  test("a client-supplied provider/model is ignored, not honoured", async () => {
    // The picker is gone: the studio runs on the host's configured model, and
    // a hand-crafted request must not be able to pick a different one.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    vi.stubEnv("STUDIO_LLM_MODEL", "");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", {
      body: { ...chatBody(), provider: "assemblyai", model: "gpt-4.1" },
    });
    expect(res.status).toBe(200);
    const [deps] = chatMock.mock.calls[0] as unknown[] as [Record<string, unknown>];
    expect(deps).not.toHaveProperty("llm");
  });
});
