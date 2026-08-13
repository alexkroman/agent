// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for the browser workflow client.
 *
 * `fetch` is stubbed rather than a server started: what these assert is the
 * REQUEST this client builds (its method, its path, its query, its bearer) and
 * what it makes of the answer — the two halves a page depends on and the two
 * that can silently disagree with `host/workflow-api.ts`.
 *
 * The hook that drives it in a loop is specced in `use-workflow-run.test.ts`.
 */

import { MAX_WORKFLOW_WAIT_MS } from "@alexkroman1/aai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWorkflowApi, type WorkflowRun } from "./workflow-client.ts";

const BASE = "https://agents.example/my-agent/";

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRun;
}

/** A JSON response, as `fetch` resolves one. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** The URL and init of the nth request this client made. */
function call(n = 0): [string, RequestInit | undefined] {
  const args = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return args;
}

describe("createWorkflowApi", () => {
  test("builds every path under the agent's own base URL", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [{ name: "digest" }] }));
    await createWorkflowApi({ baseUrl: BASE }).list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("a base URL with no trailing slash resolves the same way", async () => {
    // One resolver (`buildAgentUrl`) rather than a second trailing-slash rule —
    // two of those is how the session's endpoints and this one drift.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApi({ baseUrl: "https://agents.example/my-agent" }).list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("a token rides every request as a bearer", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApi({ baseUrl: BASE, token: "s3cret" }).list();
    expect(call()[1]?.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  test("start posts the workflow, the input and the key, and resolves the run id", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    const id = await createWorkflowApi({ baseUrl: BASE }).start(
      "digest",
      { topic: "ai" },
      { key: "caller-1" },
    );
    expect(id).toBe("wrun_9");
    const [url, init] = call();
    expect(url).toBe("https://agents.example/my-agent/workflows/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      workflow: "digest",
      input: { topic: "ai" },
      key: "caller-1",
    });
  });

  test("start omits `input` and `key` entirely when they were not given", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    await createWorkflowApi({ baseUrl: BASE }).start("digest");
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ workflow: "digest" });
  });

  test("a failure carries the SERVER'S sentence, not the status", async () => {
    // That text is the whole diagnostic: an unknown workflow names the declared
    // ones, a bad input names the schema issues.
    fetchMock.mockImplementation(async () =>
      json({ error: 'Workflow "nope" is not declared' }, 400),
    );
    await expect(createWorkflowApi({ baseUrl: BASE }).start("nope")).rejects.toThrow(
      'Workflow "nope" is not declared',
    );
  });

  test("a failure that is not our JSON shape degrades to the status", async () => {
    // What a proxy or gateway in front of the agent produces.
    fetchMock.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).rejects.toThrow("Workflow API 502");
  });

  test("get resolves UNDEFINED for a 404 — an answer, not a failure", async () => {
    fetchMock.mockImplementation(async () => json({ error: "No workflow run with id gone" }, 404));
    await expect(createWorkflowApi({ baseUrl: BASE }).get("gone")).resolves.toBeUndefined();
  });

  test("find sends the key; recent sends none", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    const api = createWorkflowApi({ baseUrl: BASE });
    await api.find("digest", "caller-1", { limit: 3 });
    await api.recent("digest");
    expect(call(0)[0]).toContain("workflow=digest&key=caller-1&limit=3");
    expect(call(1)[0]).toContain("workflow=digest");
    expect(call(1)[0]).not.toContain("key=");
  });

  test("a body answering without `runs` reads as an empty list", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await expect(createWorkflowApi({ baseUrl: BASE }).recent("digest")).resolves.toEqual([]);
  });

  test("cancel is a DELETE and reports whether THIS call ended the run", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", cancelled: false }));
    const cancelled = await createWorkflowApi({ baseUrl: BASE }).cancel("wrun_1");
    expect(cancelled).toBe(false);
    expect(call()[1]?.method).toBe("DELETE");
  });

  test("a run id is percent-encoded into every path", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await createWorkflowApi({ baseUrl: BASE }).get("a/b");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/a%2Fb");
  });

  test("watch asks for an event stream and returns the raw response", async () => {
    // Raw, because what a caller decides first is whether the agent serves this
    // at all — an older deploy answers 404 and it falls back to polling.
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await createWorkflowApi({ baseUrl: BASE }).watch("wrun_1");
    expect(res.status).toBe(404);
    expect(call()[0]).toContain("/workflows/runs/wrun_1/events");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });

  test("streamOutput asks for the run's own chunks, raw like watch", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await createWorkflowApi({ baseUrl: BASE }).streamOutput("wrun_1");
    expect(res.status).toBe(404);
    // No query at all when nothing was asked for — the whole stream from 0.
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1/stream");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });

  test("streamOutput carries namespace and startIndex, negative included", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await createWorkflowApi({ baseUrl: BASE }).streamOutput("wrun_1", {
      namespace: "progress",
      startIndex: -3,
    });
    expect(call()[0]).toContain("namespace=progress");
    expect(call()[0]).toContain("startIndex=-3");
  });

  test("streamOutput forwards an abort signal", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const controller = new AbortController();
    await createWorkflowApi({ baseUrl: BASE }).streamOutput("wrun_1", {
      signal: controller.signal,
    });
    expect(call()[1]?.signal).toBe(controller.signal);
  });

  test("wake is a POST reporting how many sleeps it ended", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", woken: 2 }));
    const woken = await createWorkflowApi({ baseUrl: BASE }).wake("wrun_1");
    expect(woken).toBe(2);
    expect(call()[1]?.method).toBe("POST");
    expect(call()[0]).toContain("/workflows/runs/wrun_1/wake");
  });

  test("wake resolves 0 for a 404 — nothing was sleeping, which is an answer", async () => {
    fetchMock.mockImplementation(async () => json({ error: "gone" }, 404));
    await expect(createWorkflowApi({ baseUrl: BASE }).wake("gone")).resolves.toBe(0);
  });

  test("wake reads 0 from a body that answered without `woken`", async () => {
    // An older agent, or a proxy that rewrote the body: absent is not 'many'.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1" }));
    await expect(createWorkflowApi({ baseUrl: BASE }).wake("wrun_1")).resolves.toBe(0);
  });

  test("wake surfaces a real failure rather than reporting 0", async () => {
    // The one case that must NOT degrade to an answer: 0 means "not sleeping",
    // and reporting it for a 500 would hide a broken agent behind a normal reply.
    fetchMock.mockImplementation(async () => json({ error: "boom" }, 500));
    await expect(createWorkflowApi({ baseUrl: BASE }).wake("wrun_1")).rejects.toThrow("boom");
  });
});

describe("startAndWait", () => {
  test("asks the agent to hold the request open and resolves the finished run", async () => {
    fetchMock.mockImplementation(async () =>
      json({ runId: "wrun_9", run: run({ runId: "wrun_9", status: "completed", output: 3 }) }),
    );

    const finished = await createWorkflowApi({ baseUrl: BASE }).startAndWait("digest", {
      url: "u",
    });

    const body = JSON.parse(String(call()[1]?.body)) as { workflow: string; wait: number };
    expect(body.workflow).toBe("digest");
    expect(body.wait).toBeGreaterThan(0);
    expect(finished).toMatchObject({ status: "completed", output: 3 });
  });

  test("clamps a wait past the cap, so it cannot outlast what the agent will hold", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9", run: run() }));
    await createWorkflowApi({ baseUrl: BASE }).startAndWait("digest", undefined, {
      wait: 10 * 60_000,
    });
    const body = JSON.parse(String(call()[1]?.body)) as { wait: number };
    expect(body.wait).toBe(MAX_WORKFLOW_WAIT_MS);
  });

  test("resolves a still-running run rather than failing when the wait ran out", async () => {
    // The agent answers 202 with the running snapshot; that is an answer, and a
    // caller checks `isTerminal` rather than assuming.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9", run: run() }, 202));
    const started = await createWorkflowApi({ baseUrl: BASE }).startAndWait("digest");
    expect(started).toMatchObject({ runId: "wrun_1", status: "running" });
  });

  test("reads the run back when the agent is too old to understand `wait`", async () => {
    // Such a deploy answers `{ runId }` and nothing else. One extra read turns
    // that into the same shape rather than an `undefined` every caller branches
    // on.
    fetchMock
      .mockImplementationOnce(async () => json({ runId: "wrun_9" }, 202))
      .mockImplementationOnce(async () => json(run({ runId: "wrun_9", status: "completed" })));

    const finished = await createWorkflowApi({ baseUrl: BASE }).startAndWait("digest");

    expect(call(1)[0]).toContain("/workflows/runs/wrun_9");
    expect(finished).toMatchObject({ runId: "wrun_9", status: "completed" });
  });

  test("still reports the run id when the read back finds nothing", async () => {
    fetchMock
      .mockImplementationOnce(async () => json({ runId: "wrun_9" }, 202))
      .mockImplementationOnce(async () => json({ error: "no such run" }, 404));

    const started = await createWorkflowApi({ baseUrl: BASE }).startAndWait("digest");

    // The caller has the id, which is what `useWorkflowRun` needs; saying
    // `pending` is both true and useful.
    expect(started).toMatchObject({ runId: "wrun_9", status: "pending" });
  });

  test("a rejected input rejects with the agent's own sentence", async () => {
    fetchMock.mockImplementation(async () => json({ error: "url: invalid" }, 400));
    await expect(createWorkflowApi({ baseUrl: BASE }).startAndWait("digest")).rejects.toThrow(
      /url: invalid/,
    );
  });
});

describe("get with a wait", () => {
  test("puts the budget on the query", async () => {
    fetchMock.mockImplementation(async () => json(run({ status: "completed" })));
    await createWorkflowApi({ baseUrl: BASE }).get("wrun_1", { wait: 5000 });
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1?wait=5000");
  });

  test("sends no query at all without one", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await createWorkflowApi({ baseUrl: BASE }).get("wrun_1");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1");
  });
});
