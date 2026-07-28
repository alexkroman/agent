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

// Chat streaming: replace the LLM loop with a scripted NDJSON stream so the
// route's streaming plumbing is exercised without a model.
const chatMock = vi.fn((..._args: unknown[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`${JSON.stringify({ type: "text", text: "hi!" })}\n`));
      controller.enqueue(enc.encode(`${JSON.stringify({ type: "done" })}\n`));
      controller.close();
    },
  });
});
vi.mock("./studio-agent.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-agent.ts")>();
  return { ...original, runStudioChat: (...args: unknown[]) => chatMock(...args) };
});

function createProject(fetch: TestFetch, name = "proj", key = "key1"): Promise<Response> {
  return authFetch(fetch, "/studio/projects", { body: { name }, key });
}

describe("studio page + routing", () => {
  test("GET / serves the studio page with a strict CSP", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("AAI");
    expect(html).toContain("Studio");
    expect(html).toContain("/studio/status");
  });

  test("GET /studio and /studio/ redirect to the page", async () => {
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio")).status).toBe(302);
    expect((await fetch("/studio/")).status).toBe(302);
  });

  test("GET /studio/status is public and reports LLM availability", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/studio/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ llm: false });
  });

  test("the studio slug is reserved: agent routes 404 and deploys reject it", async () => {
    const { fetch } = await createTestOrchestrator();
    expect((await fetch("/studio/websocket")).status).toBe(404);
    const res = await authFetch(fetch, "/deploy", {
      body: {
        slug: "studio",
        worker: "export default {}",
        clientFiles: {},
        agentConfig: { name: "x", systemPrompt: "s", toolSchemas: [], allowedHosts: [] },
      },
    });
    expect(res.status).toBe(400);
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

  test("create rejects invalid names", async () => {
    const res = await authFetch(fetch, "/studio/projects", { body: { name: "Bad Name!" } });
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
    ({ fetch } = await createTestOrchestrator());
  });

  test("deploy route runs the pipeline and returns the URL", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/deploy", {
      body: { env: { ASSEMBLYAI_API_KEY: "k" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: "proj", url: "/proj/" });
    expect(deployMock).toHaveBeenCalledTimes(1);
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
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", {
      body: { project: "proj", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status).toBe(503);
  });

  test("chat 404s for a missing project before touching the LLM", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const res = await authFetch(fetch, "/studio/chat", {
      body: { project: "ghost", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status).toBe(404);
  });

  test("chat streams NDJSON events for a valid request", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", {
      body: { project: "proj", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([{ type: "text", text: "hi!" }, { type: "done" }]);
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [deps, messages] = chatMock.mock.calls[0] as unknown[] as [
      { project: string; scope: string },
      { role: string; content: string }[],
    ];
    expect(deps.project).toBe("proj");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("chat validates the body", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/chat", {
      body: { project: "proj", messages: [] },
    });
    expect(res.status).toBe(400);
  });
});
