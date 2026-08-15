// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the workflow API client.
 *
 * `fetch` is stubbed rather than a server started: what these assert is the
 * REQUEST this client builds (its method, its path, its query, its bearer, its
 * deadline) and what it makes of the answer — the two halves every caller
 * depends on and the two that can silently disagree with `host/workflow-api.ts`.
 *
 * They came from `aai-ui/workflow-client.test.ts` with the implementation, which
 * is the point: three packages shared one client and only one of them had this
 * coverage, so the CLI and the studio each carried a subset nothing pinned.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWorkflowApiClient, WORKFLOW_API_PREFIX } from "./workflow-api-client.ts";
import { MAX_WORKFLOW_WAIT_MS, type WorkflowRunSnapshot } from "./workflow-run.ts";

const BASE = "https://agents.example/my-agent/";

function client(over: { token?: string; timeoutMs?: number } = {}) {
  return createWorkflowApiClient({ baseUrl: BASE, ...over });
}

function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
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
  return fetchMock.mock.calls[n] as [string, RequestInit | undefined];
}

describe("createWorkflowApiClient", () => {
  test("resolves every path under the agent's own base URL", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [{ name: "digest" }] }));
    await client().list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("a base URL with no trailing slash resolves the same way", async () => {
    // One resolver rather than a trailing-slash rule per call site — two of those
    // is how the three copies this replaced drifted.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApiClient({ baseUrl: "https://agents.example/my-agent" }).list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("the prefix is joined RELATIVELY, so a deployed agent's own path survives", async () => {
    // `new URL("/workflows", base)` is absolute and would drop the slug segment,
    // turning every request for a deployed agent into one for the platform root.
    expect(WORKFLOW_API_PREFIX.startsWith("/")).toBe(true);
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApiClient({ baseUrl: "https://platform.example/some-slug" }).list();
    expect(new URL(call()[0]).pathname).toBe("/some-slug/workflows");
  });

  test("a token rides every request as a bearer", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client({ token: "s3cret" }).list();
    expect(call()[1]?.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  test("no token means no authorization header at all", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client().list();
    expect(call()[1]?.headers).toEqual({});
  });

  test("start posts the workflow, the input and the key, and resolves the run id", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    const id = await client().start("digest", { topic: "ai" }, { key: "caller-1" });
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

  test("start omits `input`, `key` and `wait` entirely when they were not given", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    await client().start("digest");
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ workflow: "digest" });
  });

  test("a failure carries the SERVER'S sentence, not the status", async () => {
    // That text is the whole diagnostic: an unknown workflow names the declared
    // ones, a bad input names the schema issues.
    fetchMock.mockImplementation(async () =>
      json({ error: 'Workflow "nope" is not declared' }, 400),
    );
    await expect(client().start("nope")).rejects.toThrow('Workflow "nope" is not declared');
  });

  test("a failure that is not our JSON shape degrades to the status, NAMED", async () => {
    // What a proxy or gateway in front of the agent produces. The label appears
    // only here — prefixing the agent's own sentence would put our words in
    // front of the ones worth reading.
    fetchMock.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(client().list()).rejects.toThrow("Workflow API 502");
  });

  test("get resolves UNDEFINED for a 404 — an answer, not a failure", async () => {
    fetchMock.mockImplementation(async () => json({ error: "No workflow run with id gone" }, 404));
    await expect(client().get("gone")).resolves.toBeUndefined();
  });

  test("find sends the key; recent sends none", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    const api = client();
    await api.find("digest", "caller-1", { limit: 3 });
    await api.recent("digest");
    expect(call(0)[0]).toContain("workflow=digest&key=caller-1&limit=3");
    expect(call(1)[0]).toContain("workflow=digest");
    expect(call(1)[0]).not.toContain("key=");
  });

  test("a limit that was not asked for is not encoded", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    await client().recent("digest");
    expect(call()[0]).not.toContain("limit=");
  });

  test("a body answering without `runs` reads as an empty list", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await expect(client().recent("digest")).resolves.toEqual([]);
  });

  test("a body answering without `workflows` reads as an empty list", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await expect(client().list()).resolves.toEqual([]);
  });

  test("cancel is a DELETE and reports whether THIS call ended the run", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", cancelled: false }));
    const cancelled = await client().cancel("wrun_1");
    expect(cancelled).toBe(false);
    expect(call()[1]?.method).toBe("DELETE");
  });

  test("a run id is percent-encoded into every path", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await client().get("a/b");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/a%2Fb");
  });

  test("watch asks for an event stream and returns the raw response", async () => {
    // Raw, because what a caller decides first is whether the agent serves this
    // at all — an older deploy answers 404 and it falls back to polling.
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await client().watch("wrun_1");
    expect(res.status).toBe(404);
    expect(call()[0]).toContain("/workflows/runs/wrun_1/events");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });

  test("streamOutput asks for the run's own chunks, raw like watch", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await client().streamOutput("wrun_1");
    expect(res.status).toBe(404);
    // No query at all when nothing was asked for — the whole stream from 0.
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1/stream");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });

  test("streamOutput carries namespace and startIndex, negative included", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await client().streamOutput("wrun_1", { namespace: "progress", startIndex: -3 });
    expect(call()[0]).toContain("namespace=progress");
    expect(call()[0]).toContain("startIndex=-3");
  });

  test("streamOutput encodes a startIndex of 0, which is not absent", async () => {
    // `omitUndefined` over a pre-stringified value rather than the number, so
    // the falsy-but-meaningful `0` survives.
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await client().streamOutput("wrun_1", { startIndex: 0 });
    expect(call()[0]).toContain("startIndex=0");
  });

  test("streamOutput forwards an abort signal", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const controller = new AbortController();
    await client().streamOutput("wrun_1", { signal: controller.signal });
    expect(call()[1]?.signal).toBe(controller.signal);
  });

  test("wake is a POST reporting how many sleeps it ended", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", woken: 2 }));
    const woken = await client().wake("wrun_1");
    expect(woken).toBe(2);
    expect(call()[1]?.method).toBe("POST");
    expect(call()[0]).toContain("/workflows/runs/wrun_1/wake");
  });

  test("wake resolves 0 for a 404 — nothing was sleeping, which is an answer", async () => {
    fetchMock.mockImplementation(async () => json({ error: "gone" }, 404));
    await expect(client().wake("gone")).resolves.toBe(0);
  });

  test("wake reads 0 from a body that answered without `woken`", async () => {
    // An older agent, or a proxy that rewrote the body: absent is not 'many'.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1" }));
    await expect(client().wake("wrun_1")).resolves.toBe(0);
  });

  test("wake surfaces a real failure rather than reporting 0", async () => {
    // The one case that must NOT degrade to an answer: 0 means "not sleeping",
    // and reporting it for a 500 would hide a broken agent behind a normal reply.
    fetchMock.mockImplementation(async () => json({ error: "boom" }, 500));
    await expect(client().wake("wrun_1")).rejects.toThrow("boom");
  });

  test("watch passes the caller's abort signal and sends none without one", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const controller = new AbortController();
    const api = client();
    await api.watch("wrun_1", controller.signal);
    await api.watch("wrun_2");
    expect(call(0)[1]?.signal).toBe(controller.signal);
    expect(call(1)[1]).not.toHaveProperty("signal");
  });
});

describe("startAndWait", () => {
  test("asks the agent to hold the request open and resolves the finished run", async () => {
    fetchMock.mockImplementation(async () =>
      json({ runId: "wrun_9", run: run({ runId: "wrun_9", status: "completed", output: 3 }) }),
    );

    const finished = await client().startAndWait("digest", { url: "u" });

    const body = JSON.parse(String(call()[1]?.body)) as { workflow: string; wait: number };
    expect(body.workflow).toBe("digest");
    expect(body.wait).toBeGreaterThan(0);
    expect(finished).toMatchObject({ status: "completed", output: 3 });
  });

  test("clamps a wait past the cap, so it cannot outlast what the agent will hold", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9", run: run() }));
    await client().startAndWait("digest", undefined, { wait: 10 * 60_000 });
    const body = JSON.parse(String(call()[1]?.body)) as { wait: number };
    expect(body.wait).toBe(MAX_WORKFLOW_WAIT_MS);
  });

  test("resolves a still-running run rather than failing when the wait ran out", async () => {
    // The agent answers 202 with the running snapshot; that is an answer, and a
    // caller checks `isTerminal` rather than assuming.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9", run: run() }, 202));
    const started = await client().startAndWait("digest");
    expect(started).toMatchObject({ runId: "wrun_1", status: "running" });
  });

  test("reads the run back when the agent is too old to understand `wait`", async () => {
    // Such a deploy answers `{ runId }` and nothing else. One extra read turns
    // that into the same shape rather than an `undefined` every caller branches
    // on.
    fetchMock
      .mockImplementationOnce(async () => json({ runId: "wrun_9" }, 202))
      .mockImplementationOnce(async () => json(run({ runId: "wrun_9", status: "completed" })));

    const finished = await client().startAndWait("digest");

    expect(call(1)[0]).toContain("/workflows/runs/wrun_9");
    expect(finished).toMatchObject({ runId: "wrun_9", status: "completed" });
  });

  test("still reports the run id when the read back finds nothing", async () => {
    fetchMock
      .mockImplementationOnce(async () => json({ runId: "wrun_9" }, 202))
      .mockImplementationOnce(async () => json({ error: "no such run" }, 404));

    const started = await client().startAndWait("digest");

    // The caller has the id, which is what a watch needs; saying `pending` is
    // both true and useful.
    expect(started).toMatchObject({ runId: "wrun_9", status: "pending" });
  });

  test("a rejected input rejects with the agent's own sentence", async () => {
    fetchMock.mockImplementation(async () => json({ error: "url: invalid" }, 400));
    await expect(client().startAndWait("digest")).rejects.toThrow(/url: invalid/);
  });
});

describe("get with a wait", () => {
  test("puts the budget on the query", async () => {
    fetchMock.mockImplementation(async () => json(run({ status: "completed" })));
    await client().get("wrun_1", { wait: 5000 });
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1?wait=5000");
  });

  test("sends no query at all without one", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await client().get("wrun_1");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1");
  });
});

/**
 * The deadline, which is the one thing no copy of this client had and one caller
 * (the studio's card) had hand-rolled around every fetch.
 *
 * A hung request is not a failure — `fetch` carries no timeout of its own, so it
 * never settles and no error path, retry or backoff ever runs.
 */
describe("timeoutMs", () => {
  test("no deadline at all when it was not asked for", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client().list();
    expect(call()[1]).not.toHaveProperty("signal");
  });

  test("arms one on an ordinary read", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client({ timeoutMs: 20_000 }).list();
    expect(call()[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("both waiting paths get the agent's own budget ON TOP of it", async () => {
    // Otherwise a 20s client deadline cuts a 60s wait in the middle and reports
    // a network error for a run that is perfectly healthy — losing the one thing
    // the caller cannot rebuild.
    //
    // The DURATION is asserted through the factory rather than by advancing a
    // clock: `AbortSignal.timeout` is a platform timer, so `vi.useFakeTimers`
    // does not drive it and a signal that never fires reads as a pass.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockImplementation(async () => json(run()));
    const api = client({ timeoutMs: 20_000 });

    await api.get("wrun_1", { wait: MAX_WORKFLOW_WAIT_MS });
    await api.startAndWait("digest");

    // Every request either path made, the `startAndWait` read-back included.
    expect(timeout.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(timeout.mock.calls.flat()).toEqual(
      timeout.mock.calls.map(() => 20_000 + MAX_WORKFLOW_WAIT_MS),
    );
  });

  test("both event streams are EXEMPT — a healthy one stays open indefinitely", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const api = client({ timeoutMs: 20_000 });
    await api.watch("wrun_1");
    await api.streamOutput("wrun_1");
    expect(call(0)[1]).not.toHaveProperty("signal");
    expect(call(1)[1]).not.toHaveProperty("signal");
  });
});

describe("a 2xx that is not JSON", () => {
  /**
   * The status does not decide whether a body is JSON. A proxy, a CDN or a
   * platform broker answering while a sandbox boots all reply `200 text/html`,
   * and `res.json()` rejected with a bare `SyntaxError` — no status, no label,
   * and for `POST /runs` no `runId` for a run the agent may already have
   * created, which is the one thing on this surface a caller cannot rebuild.
   */
  const html = () =>
    new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  test.each([
    ["list", (api: ReturnType<typeof client>) => api.list()],
    ["start", (api: ReturnType<typeof client>) => api.start("digest")],
    ["startAndWait", (api: ReturnType<typeof client>) => api.startAndWait("digest")],
    ["get", (api: ReturnType<typeof client>) => api.get("wrun_1")],
    ["find", (api: ReturnType<typeof client>) => api.find("digest", "k")],
    ["recent", (api: ReturnType<typeof client>) => api.recent("digest")],
    ["cancel", (api: ReturnType<typeof client>) => api.cancel("wrun_1")],
    ["wake", (api: ReturnType<typeof client>) => api.wake("wrun_1")],
    ["upload", (api: ReturnType<typeof client>) => api.upload("bytes", { name: "a.txt" })],
  ])("%s reports the surface, the status and a preview — not a SyntaxError", async (_name, run) => {
    fetchMock.mockImplementation(async () => html());
    await expect(run(client())).rejects.toThrow(
      "Workflow API 200: <html><body>502 Bad Gateway</body></html>",
    );
  });

  test("an empty 2xx body is the bare labelled status", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
    await expect(client().list()).rejects.toThrow("Workflow API 200");
  });

  test("a long body is capped and marked, so a whole page cannot reach a toast", async () => {
    fetchMock.mockImplementation(async () => new Response("z".repeat(5000), { status: 200 }));
    await expect(client().list()).rejects.toThrow(`Workflow API 200: ${"z".repeat(200)}…`);
  });

  test("a NON-2xx still reports the agent's own sentence, unchanged", async () => {
    // The guard above must not shadow the failure path: `{ error }` is the whole
    // diagnostic and it is what a caller sees.
    fetchMock.mockImplementation(async () => json({ error: "No workflow named digest" }, 400));
    await expect(client().start("digest")).rejects.toThrow("No workflow named digest");
  });
});
