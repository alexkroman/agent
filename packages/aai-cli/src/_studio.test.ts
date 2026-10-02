// Copyright 2026 the AAI authors. MIT license.
// The `/studio/projects` clients and URL builders (_studio.ts). The source
// walk and `projectNameFromDir` are covered with the commands in
// studio.test.ts. `apiRequest` reads the global `fetch` per call, so the
// network is stubbed there rather than by a module mock.

import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import {
  fetchStudioProject,
  listStudioProjects,
  publishStudioProject,
  pushStudioSource,
  studioProjectApiUrl,
  studioProjectUrl,
} from "./_studio.ts";

const SERVER = "https://platform.example";

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL and init of the nth request. */
function call(n = 0): { url: string; init: RequestInit | undefined } {
  const [url, init] = fetchMock.mock.calls[n] ?? [];
  return { url: String(url), init };
}

describe("project URLs", () => {
  test("the shareable URL is the project's chat page", () => {
    expect(studioProjectUrl(SERVER, "my-agent")).toBe(`${SERVER}/studio/chat/my-agent`);
  });

  test("the API base encodes the name, which comes from the working tree", () => {
    expect(studioProjectApiUrl(SERVER, "a/../b")).toBe(`${SERVER}/studio/projects/a%2F..%2Fb`);
  });
});

describe("listStudioProjects", () => {
  test("returns the account's project names, authenticated", async () => {
    fetchMock.mockResolvedValue(json({ projects: ["alpha", "beta"] }));
    expect(await listStudioProjects(SERVER, "key-1")).toEqual(["alpha", "beta"]);
    expect(call().url).toBe(`${SERVER}/studio/projects`);
    expect(new Headers(call().init?.headers).get("authorization")).toBe("Bearer key-1");
  });

  test("a 200 without a project list is refused, not iterated", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await expect(listStudioProjects(SERVER, "k")).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("fetchStudioProject", () => {
  test("a missing project is null — the push existence probe", async () => {
    fetchMock.mockResolvedValue(json({ error: "Project not found" }, 404));
    expect(await fetchStudioProject(SERVER, "k", "ghost")).toBeNull();
    expect(call().url).toBe(`${SERVER}/studio/projects/ghost`);
  });

  test("returns the workspace when it carries files and a hash", async () => {
    const project = { files: { "agent.ts": "x" }, sourceHash: "h1", deployedSlug: "p" };
    fetchMock.mockResolvedValue(json(project));
    expect(await fetchStudioProject(SERVER, "k", "p")).toEqual(project);
  });

  test("a 200 whose files are not all strings is refused", async () => {
    fetchMock.mockResolvedValue(json({ files: { "agent.ts": 1 }, sourceHash: "h" }));
    await expect(fetchStudioProject(SERVER, "k", "p")).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("pushStudioSource", () => {
  test("PUTs the file map and fast-forward token to the source route", async () => {
    fetchMock.mockResolvedValue(json({ sourceHash: "h2", created: false }));
    const result = await pushStudioSource(SERVER, "k", "p", {
      files: { "agent.ts": "y" },
      baseHash: "h1",
    });
    expect(result).toEqual({ sourceHash: "h2", created: false });
    expect(call().url).toBe(`${SERVER}/studio/projects/p/source`);
    expect(call().init?.method).toBe("PUT");
    expect(JSON.parse(String(call().init?.body))).toEqual({
      files: { "agent.ts": "y" },
      baseHash: "h1",
    });
  });

  test("a 200 without the new hash is refused — it is the next push's token", async () => {
    fetchMock.mockResolvedValue(json({ created: true }));
    await expect(pushStudioSource(SERVER, "k", "p", { files: {} })).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("publishStudioProject", () => {
  test("POSTs to the deploy route, sending skipTypecheck either way", async () => {
    // A fresh Response per call: a body can be read once.
    fetchMock.mockImplementation(async () =>
      json({ ok: true, slug: "p", url: `${SERVER}/p`, output: "" }),
    );
    await publishStudioProject(SERVER, "k", "p");
    expect(call().url).toBe(`${SERVER}/studio/projects/p/deploy`);
    expect(call().init?.method).toBe("POST");
    expect(JSON.parse(String(call().init?.body))).toEqual({ skipTypecheck: false });

    await publishStudioProject(SERVER, "k", "p", { skipTypecheck: true });
    expect(JSON.parse(String(call(1).init?.body))).toEqual({ skipTypecheck: true });
  });

  test("a failed publish is not retried — each attempt is a whole in-sandbox build", async () => {
    fetchMock.mockImplementation(async () => json({ error: "boom" }, 500));
    await expect(publishStudioProject(SERVER, "k", "p")).rejects.toThrow("HTTP 500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
