// Copyright 2026 the AAI authors. MIT license.
/**
 * What `read_logs` reads: the project's own deployed agent, resolved from the
 * workspace rather than from anything the guest said.
 */

import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { readProjectLogs } from "./studio-agent-logs.ts";
import { createWorkspace, stampWorkspaceMeta } from "./studio-workspace.ts";

const SCOPE = "scope-1";
const PROJECT = "proj";
const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key" };

type Line = { seq: number; at: number; stream: "stdout" | "stderr"; text: string };

/**
 * The seam `readProjectLogs` takes, named once. A `vi.fn<FetchFn>` is
 * assignable to it as-is, which is what keeps this file free of casts — the
 * fake IS a fetch rather than a shape narrowed into one.
 */
type FetchFn = typeof globalThis.fetch;

/** One page of the platform's `GET /:slug/logs`, as JSON. */
function pageResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function line(seq: number, text: string, stream: Line["stream"] = "stdout"): Line {
  return { seq, at: 1_700_000_000_000 + seq, stream, text };
}

/** A workspace with whichever slugs the case needs stamped on it. */
async function makeWorkspace(meta: { previewSlug?: string; deployedSlug?: string } = {}) {
  const workspaces = createMemoryWorkspaceStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
  if (Object.keys(meta).length > 0) {
    await stampWorkspaceMeta(workspaces, SCOPE, PROJECT, meta);
  }
  return workspaces;
}

/** A fake platform that serves one page per call, in order. */
function pagingFetch(pages: { lines: Line[]; cursor: number; dropped?: number }[]) {
  const calls: string[] = [];
  const fetchFn = vi.fn<FetchFn>(async (input) => {
    calls.push(String(input));
    const page = pages[calls.length - 1] ?? { lines: [], cursor: -1 };
    return pageResponse({ ...page, dropped: page.dropped ?? 0, running: true });
  });
  return { fetchFn, calls };
}

describe("readProjectLogs", () => {
  test("an environment with no deployed agent reads as empty, not as an error", async () => {
    const workspaces = await makeWorkspace();
    const { fetchFn, calls } = pagingFetch([]);
    const result = await readProjectLogs({
      workspaces,
      scope: SCOPE,
      project: PROJECT,
      target: TARGET,
      fetchFn,
    });
    expect(result).toEqual({ running: false, lines: [], dropped: 0, total: 0 });
    // Nothing to read means nothing is asked of the platform — the tool's own
    // prose is what tells the agent to make an edit and wait for a preview.
    expect(calls).toEqual([]);
  });

  test("the environment picks the slug, and the guest never names one", async () => {
    const workspaces = await makeWorkspace({ previewSlug: "proj-preview", deployedSlug: "proj" });
    // One line then an empty page per read, so each drain ends on its own.
    const page = { lines: [line(0, "hi")], cursor: 0 };
    const empty = { lines: [], cursor: 0 };
    const { fetchFn, calls } = pagingFetch([page, empty, page, empty]);
    const deps = { workspaces, scope: SCOPE, project: PROJECT, target: TARGET, fetchFn };

    await readProjectLogs(deps);
    await readProjectLogs(deps, { environment: "production" });

    // The FIRST read of each drain names the slug the environment resolved to.
    expect(calls.filter((c) => c.endsWith("after=-1"))).toEqual([
      "https://platform.example/proj-preview/logs?after=-1",
      "https://platform.example/proj/logs?after=-1",
    ]);
  });

  test("the account key is the bearer — the log route is owner-authenticated", async () => {
    const workspaces = await makeWorkspace({ previewSlug: "proj-preview" });
    const fetchFn = vi.fn<FetchFn>(async () =>
      pageResponse({ lines: [], cursor: -1, dropped: 0, running: false }),
    );
    await readProjectLogs({ workspaces, scope: SCOPE, project: PROJECT, target: TARGET, fetchFn });
    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-key");
  });

  /**
   * The ring hands back the OLDEST lines after a cursor, so "what just broke"
   * is only reachable by draining forward and keeping the tail.
   */
  test("drains by cursor and returns the LAST lines, not the first", async () => {
    const workspaces = await makeWorkspace({ previewSlug: "proj-preview" });
    const { fetchFn, calls } = pagingFetch([
      { lines: [line(0, "a"), line(1, "b")], cursor: 1 },
      { lines: [line(2, "c"), line(3, "d")], cursor: 3 },
      { lines: [], cursor: 3 },
    ]);
    const result = await readProjectLogs(
      { workspaces, scope: SCOPE, project: PROJECT, target: TARGET, fetchFn },
      { limit: 2 },
    );
    expect(result.lines.map((l) => l.text)).toEqual(["c", "d"]);
    expect(result.total).toBe(4);
    expect(calls).toEqual([
      "https://platform.example/proj-preview/logs?after=-1",
      "https://platform.example/proj-preview/logs?after=1",
      "https://platform.example/proj-preview/logs?after=3",
    ]);
  });

  test("a cursor that does not advance ends the drain rather than spinning", async () => {
    const workspaces = await makeWorkspace({ previewSlug: "proj-preview" });
    const { fetchFn, calls } = pagingFetch(
      // Every page claims the same cursor while still returning lines — a far
      // side that would otherwise be read until the page budget ran out.
      Array.from({ length: 8 }, () => ({ lines: [line(0, "stuck")], cursor: -1 })),
    );
    const result = await readProjectLogs({
      workspaces,
      scope: SCOPE,
      project: PROJECT,
      target: TARGET,
      fetchFn,
    });
    expect(calls).toHaveLength(1);
    expect(result.lines).toHaveLength(1);
  });

  test("eviction is reported, never swallowed", async () => {
    const workspaces = await makeWorkspace({ previewSlug: "proj-preview" });
    const { fetchFn } = pagingFetch([{ lines: [line(9, "late")], cursor: 9, dropped: 9 }]);
    const result = await readProjectLogs({
      workspaces,
      scope: SCOPE,
      project: PROJECT,
      target: TARGET,
      fetchFn,
    });
    expect(result.dropped).toBe(9);
  });

  test("a refusal on the first page is the answer; one mid-drain keeps what we have", async () => {
    const workspaces = await makeWorkspace({ previewSlug: "proj-preview" });
    const deps = { workspaces, scope: SCOPE, project: PROJECT, target: TARGET };

    const refuse = vi.fn<FetchFn>(async () => new Response("nope", { status: 403 }));
    await expect(readProjectLogs({ ...deps, fetchFn: refuse })).rejects.toThrow(/403/);

    let call = 0;
    const failLater = vi.fn<FetchFn>(async () => {
      call += 1;
      return call === 1
        ? pageResponse({ lines: [line(0, "a")], cursor: 0, running: true })
        : new Response("gone", { status: 500 });
    });
    const result = await readProjectLogs({ ...deps, fetchFn: failLater });
    expect(result.lines.map((l) => l.text)).toEqual(["a"]);
  });

  test("a project that does not exist is an error, not an empty log", async () => {
    const workspaces = createMemoryWorkspaceStore();
    await expect(
      readProjectLogs({ workspaces, scope: SCOPE, project: "gone", target: TARGET }),
    ).rejects.toThrow(/not found/);
  });
});
