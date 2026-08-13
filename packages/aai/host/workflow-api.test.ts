// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the workflow HTTP API.
 *
 * Driven through a REAL `node:http` server rather than fake request/response
 * objects, because half of what this module decides is HTTP: the status code a
 * caller's mistake gets (400, never 500), the one a body over the cap gets (413,
 * from the router rather than the route), and the fact that a claimed request
 * always receives exactly one answer.
 *
 * The engine is `ctx.workflows` unchanged, so the double here is a plain
 * `WorkflowClient` — which is the assertion this file makes by construction: a
 * route that needed more than a client would not compile.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { WorkflowClient } from "../sdk/workflow.ts";
import type { WorkflowRunSnapshot } from "../sdk/workflow-run.ts";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "../sdk/workflow-unavailable.ts";
import { createWorkflowApi, MAX_WORKFLOW_INPUT_BYTES } from "./workflow-api.ts";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 1_700_000_000_000,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/** A `ctx.workflows` whose every method is a spy, so a route's call is visible. */
function fakeClient(over: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    start: vi.fn(async () => "wrun_1"),
    get: vi.fn(async () => run()),
    find: vi.fn(async () => [run({ key: "caller-1" })]),
    recent: vi.fn(async () => [run()]),
    cancel: vi.fn(async () => true),
    listing: vi.fn(() => [{ name: "digest", description: "Research a topic" }]),
    ...over,
  } as WorkflowClient;
}

type Harness = {
  url: string;
  close: () => Promise<void>;
};

/** Mount the API on a real loopback server, so the tests speak HTTP. */
async function serve(opts: {
  engine: () => WorkflowClient | undefined;
  token?: string;
}): Promise<Harness> {
  const api = createWorkflowApi({
    engine: opts.engine,
    ...omitUndefined({ token: opts.token }),
    logger,
  });
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (api(req, res, url, req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
});

describe("routing", () => {
  test("does not claim a request outside the prefix", async () => {
    const claimed = createWorkflowApi({ engine: () => fakeClient(), logger })(
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      "/workflowsomething",
      "GET",
    );
    expect(claimed).toBe(false);
  });

  test("claims the bare prefix and lists the declared workflows", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      workflows: [{ name: "digest", description: "Research a topic" }],
    });
  });

  test("a claimed path with no matching method answers 404", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows`, { method: "DELETE" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  test("`/runs/:id/events` is matched before the bare `/runs/:id` GET", async () => {
    // The ordering bug this pins reads "<id>/events" as a run id, so the
    // giveaway is a 404 for a run that exists — and an SSE content type is the
    // only thing that distinguishes the two routes from outside.
    const engine = fakeClient({ get: vi.fn(async () => run({ status: "completed", output: 1 })) });
    harness = await serve({ engine: () => engine });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.text();
  });

  test("a run id is percent-decoded out of the path", async () => {
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    await fetch(`${harness.url}/workflows/runs/${encodeURIComponent("a/b")}`);
    expect(get).toHaveBeenCalledWith("a/b");
  });
});

describe("availability", () => {
  test("an undefined engine answers 404 naming BOTH causes", async () => {
    harness = await serve({ engine: () => undefined });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: WORKFLOWS_UNAVAILABLE_MESSAGE });
  });

  test("an engine resolver that THROWS answers 500 carrying the reason", async () => {
    // The distinction that matters: a runtime that could not be BUILT is a
    // misconfigured agent, and answering 404 would deny that its workflows exist.
    harness = await serve({
      engine: () => {
        throw new Error("AssemblyAI LLM: missing API key");
      },
    });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Workflow API unavailable: AssemblyAI LLM: missing API key",
    });
  });
});

describe("token", () => {
  test("no token leaves every route open", async () => {
    harness = await serve({ engine: () => fakeClient() });
    expect((await fetch(`${harness.url}/workflows`)).status).toBe(200);
  });

  test("a token refuses a request that does not carry it", async () => {
    harness = await serve({ engine: () => fakeClient(), token: "s3cret" });
    const res = await fetch(`${harness.url}/workflows`);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Missing or invalid workflow API token",
    });
  });

  test("a token admits a request carrying it", async () => {
    harness = await serve({ engine: () => fakeClient(), token: "s3cret" });
    const res = await fetch(`${harness.url}/workflows`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
  });

  test("the engine is not resolved for an unauthorized caller", async () => {
    // Resolving builds the runtime in the guest, which is work an
    // unauthenticated caller must not be able to trigger.
    const engine = vi.fn(() => fakeClient());
    harness = await serve({ engine, token: "s3cret" });
    await fetch(`${harness.url}/workflows`);
    expect(engine).not.toHaveBeenCalled();
  });
});

describe("POST /runs", () => {
  test("starts a run and answers 202 with its id", async () => {
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "digest", input: { topic: "ai" }, key: "caller-1" }),
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ runId: "wrun_9" });
    expect(start).toHaveBeenCalledWith("digest", { topic: "ai" }, { key: "caller-1" });
  });

  test("omits the key option entirely when the body carried none", async () => {
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
    });
    expect(start).toHaveBeenCalledWith("digest", undefined, undefined);
  });

  test("a body that is not JSON is a 400", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs`, { method: "POST", body: "{" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Body must be JSON" });
  });

  test("a body naming no workflow is a 400", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Body must name a workflow");
  });

  test("a non-string key is REFUSED rather than coerced", async () => {
    // Coerced, it would be indexed as `"7"` and never match the `find` a caller
    // writes with the number they passed.
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", key: 7 }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: '"key" must be a string when present' });
  });

  test("a rejected start is a 400 carrying the client's own sentence", async () => {
    const start = vi.fn(() => Promise.reject(new Error('Workflow "nope" is not declared')));
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "nope" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Workflow "nope" is not declared' });
  });

  test("a body over the cap is a 413, not a 500", async () => {
    // Mapped in the ROUTER, so a second body-reading route cannot forget it.
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: "x".repeat(MAX_WORKFLOW_INPUT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("body exceeds");
  });
});

describe("GET /runs", () => {
  test("a key narrows to `find`", async () => {
    const find = vi.fn(async () => [run({ key: "caller-1" })]);
    const recent = vi.fn(async () => []);
    harness = await serve({ engine: () => fakeClient({ find, recent }) });
    const res = await fetch(`${harness.url}/workflows/runs?workflow=digest&key=caller-1&limit=3`);
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith("digest", "caller-1", { limit: 3 });
    expect(recent).not.toHaveBeenCalled();
  });

  test("no key is the KEYLESS read — `recent`, not `find` with an empty key", async () => {
    const find = vi.fn(async () => []);
    const recent = vi.fn(async () => [run()]);
    harness = await serve({ engine: () => fakeClient({ find, recent }) });
    await fetch(`${harness.url}/workflows/runs?workflow=digest`);
    expect(recent).toHaveBeenCalledWith("digest", undefined);
    expect(find).not.toHaveBeenCalled();
  });

  test("a missing `workflow` parameter is a 400", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "A `workflow` query parameter is required",
    });
  });

  test("a non-numeric limit is a 400", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs?workflow=digest&limit=lots`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "`limit` must be a number" });
  });

  test("an unknown workflow name is a 400 carrying the client's sentence", async () => {
    const recent = vi.fn(() => Promise.reject(new Error("Declared workflows: digest")));
    harness = await serve({ engine: () => fakeClient({ recent }) });
    const res = await fetch(`${harness.url}/workflows/runs?workflow=nope`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Declared workflows: digest" });
  });
});

describe("GET and DELETE /runs/:id", () => {
  test("reads one run", async () => {
    const snapshot = run({ status: "completed", output: { ok: true } });
    harness = await serve({ engine: () => fakeClient({ get: vi.fn(async () => snapshot) }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(snapshot);
  });

  test("an unknown run is a 404 naming the id", async () => {
    harness = await serve({ engine: () => fakeClient({ get: vi.fn(async () => undefined) }) });
    const res = await fetch(`${harness.url}/workflows/runs/gone`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "No workflow run with id gone" });
  });

  test("cancel answers 200 either way — an already-finished run is an ANSWER", async () => {
    harness = await serve({ engine: () => fakeClient({ cancel: vi.fn(async () => false) }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: "wrun_1", cancelled: false });
  });
});

describe("failure handling", () => {
  test("a route that throws answers 500 rather than hanging or crashing", async () => {
    const get = vi.fn(() => Promise.reject(new Error("boom")));
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
    expect(logger.error).toHaveBeenCalledWith(
      "Workflow API request failed",
      expect.objectContaining({ error: "boom" }),
    );
  });
});

/**
 * The synchronous mode.
 *
 * The property under test is the one a caller branches on: a wait that PRODUCED
 * a finished run is a 200, and a wait that ran out is a 202 carrying the run id
 * — never an error, and never a cancel. `workflow-api-wait.test.ts` owns the
 * loop itself; these assert what the routes do with its answer.
 */
describe("wait", () => {
  /** A `get` that answers `running` until the nth read, then `completed`. */
  function settlesOnRead(nth: number) {
    let reads = 0;
    return vi.fn(async () => {
      reads += 1;
      return reads >= nth ? run({ status: "completed", output: 7 }) : run({ status: "running" });
    });
  }

  test("POST answers 200 with the finished run", async () => {
    const engine = fakeClient({ start: vi.fn(async () => "wrun_9"), get: settlesOnRead(2) });
    harness = await serve({ engine: () => engine });

    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", wait: 5000 }),
    });

    expect(res.status).toBe(200);
    // `run` rides ALONGSIDE `runId`, so a caller that only reads the id behaves
    // the same whether or not it asked to wait.
    expect(await res.json()).toEqual({
      runId: "wrun_9",
      run: expect.objectContaining({ status: "completed", output: 7 }),
    });
  });

  test("POST with no wait still answers 202 and the id alone", async () => {
    const get = vi.fn(async () => run({ status: "running" }));
    harness = await serve({ engine: () => fakeClient({ get }) });

    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "wrun_1" });
    // The asynchronous path must not read the run at all — that read is what
    // waiting IS, and paying for it unasked would make every start slower.
    expect(get).not.toHaveBeenCalled();
  });

  test("a wait that runs out is a 202 carrying the running run, not an error", async () => {
    const engine = fakeClient({
      start: vi.fn(async () => "wrun_9"),
      get: vi.fn(async () => run({ status: "running" })),
    });
    harness = await serve({ engine: () => engine });

    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", wait: 1 }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: "wrun_9", run: { status: "running" } });
    // The run is real and the caller holds its id; nothing was cancelled.
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  test("GET ?wait= holds the read open until the run settles", async () => {
    const get = settlesOnRead(3);
    harness = await serve({ engine: () => fakeClient({ get }) });

    const res = await fetch(`${harness.url}/workflows/runs/wrun_1?wait=5000`);

    expect(res.status).toBe(200);
    // The BODY is a snapshot either way, so waiting is invisible to a parser.
    expect(await res.json()).toMatchObject({ status: "completed" });
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  test("GET with no wait reads once", async () => {
    const get = vi.fn(async () => run({ status: "running" }));
    harness = await serve({ engine: () => fakeClient({ get }) });

    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("a waited read of an unknown run 404s without spending the budget", async () => {
    // A run the agent does not know will not start being known.
    const get = vi.fn(async () => undefined);
    harness = await serve({ engine: () => fakeClient({ get }) });

    const started = Date.now();
    const res = await fetch(`${harness.url}/workflows/runs/wrun_gone?wait=30000`);

    expect(res.status).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
