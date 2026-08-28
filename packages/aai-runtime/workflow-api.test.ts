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
 *
 * The harness lives in `workflow-api-test-utils.ts`, shared with
 * `workflow-api-sync.test.ts` (the `?wait=` mode, split out at the 700-line
 * test cap).
 */

import type http from "node:http";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { WorkflowRequestError } from "./_workflow-request-error.ts";
import { createWorkflowApi, MAX_WORKFLOW_INPUT_BYTES } from "./workflow-api.ts";
import { chunkStream, fakeClient, type Harness, run, serve } from "./workflow-api-test-utils.ts";
import type { UploadStore } from "./workflow-uploads.ts";

/**
 * A `WorkflowRequestError` as a SECOND copy of its module would construct one:
 * a distinct class carrying the same registered brand. `Symbol.for` is what makes
 * the two agree, so this is a faithful stand-in for the guest's real seam rather
 * than a hand-built look-alike.
 */
function foreignRequestError(message: string): Error {
  class ForeignWorkflowRequestError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "WorkflowRequestError";
      // `defineProperty` rather than a computed class field: a computed field
      // needs a `unique symbol`, which a locally-declared `Symbol.for` is not
      // (TS1166) — and the whole point here is to reach the registry by NAME, the
      // way a second copy of the module does, rather than to share a binding with
      // it. A test that imported the source's own symbol would be asserting
      // against one module, which is the case that already worked.
      Object.defineProperty(this, Symbol.for("aai.workflowRequestError"), { value: true });
    }
  }
  return new ForeignWorkflowRequestError(message);
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
    const claimed = createWorkflowApi({ engine: () => fakeClient(), logger: makeLogger() })(
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

  test.each([
    ["GET", "/workflows/runs/%"],
    ["GET", "/workflows/runs/%/events"],
    ["GET", "/workflows/runs/%zz/stream"],
    ["POST", "/workflows/runs/%C0%80/wake"],
    ["DELETE", "/workflows/runs/%A"],
  ])("%s %s is a 400, not a 500", async (method, path) => {
    // A path segment that will not percent-decode is the CALLER's mistake, and
    // the module doc's rule is "400, never 500". Before `decodePathSegment` the
    // URIError escaped `runId` into the router's catch — which reports "the agent
    // is broken", the one thing this could not be.
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}${path}`, { method });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Malformed run id" });
    expect(get).not.toHaveBeenCalled();
  });

  test("a malformed upload id is a 400 rather than reaching the store", async () => {
    const info = vi.fn(() => Promise.resolve(undefined));
    const uploads: UploadStore = {
      info,
      read: () => Promise.resolve(new Uint8Array()),
      create: () => Promise.resolve({ id: "upl_1", name: "", type: "", size: 0, complete: true }),
      stream: (id: string) => Promise.resolve({ id, name: "", type: "", size: 0, complete: true }),
      beginParts: (id: string) =>
        Promise.resolve({ id, name: "", type: "", size: 0, complete: false }),
      recordParts: (id: string) =>
        Promise.resolve({ id, name: "", type: "", size: 0, complete: false }),
      writePart: (id: string) =>
        Promise.resolve({ id, name: "", type: "", size: 0, complete: false }),
    };
    harness = await serve({ engine: () => fakeClient(), uploads });
    const res = await fetch(`${harness.url}/workflows/uploads/%`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Malformed upload id" });
    expect(info).not.toHaveBeenCalled();
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

  /**
   * The block above only ever drove `GET /workflows` — the cheapest, most
   * harmless route on the surface — so the token gate was pinned on the one
   * verb whose exposure nobody worries about, and on none of the three #1309
   * flagged: the run listing that hands out ids, and the two verbs that change a
   * run somebody else started. A token check that moved inside a route (or a
   * table entry that dispatched before the gate) would leave cancel and wake
   * open with this suite green.
   *
   * Driven as a table because the claim is identical for each and the point is
   * COVERAGE of the verb set — a loop here would report "workflow API token"
   * and not which route leaked.
   */
  test.each([
    {
      what: "the run listing (enumerates ids)",
      path: "/workflows/runs?workflow=digest",
      method: "GET",
    },
    { what: "cancel", path: "/workflows/runs/wrun_1", method: "DELETE" },
    { what: "wake", path: "/workflows/runs/wrun_1/wake", method: "POST" },
  ])("a token closes $what", async ({ path, method }) => {
    const client = fakeClient();
    harness = await serve({ engine: () => client, token: "s3cret" });

    const refused = await fetch(`${harness.url}${path}`, { method });
    expect(refused.status).toBe(401);
    // And it was refused BEFORE reaching the engine — a 401 that still ran the
    // call would have cancelled the run it was refusing.
    expect(client.recent).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.wakeUp).not.toHaveBeenCalled();

    const admitted = await fetch(`${harness.url}${path}`, {
      method,
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(admitted.status).toBe(200);
  });

  test("with no token those same three routes are OPEN — the documented default", async () => {
    // Pinned deliberately, and not as an endorsement: `workflow-api-auth.ts`
    // argues the posture and names closing the enumeration arm as the open
    // question. If that decision is taken, THIS is the test that has to change,
    // which is the point of writing it down as a test rather than as prose.
    const client = fakeClient();
    harness = await serve({ engine: () => client });
    for (const [path, method] of [
      ["/workflows/runs?workflow=digest", "GET"],
      ["/workflows/runs/wrun_1", "DELETE"],
      ["/workflows/runs/wrun_1/wake", "POST"],
    ] as const) {
      expect((await fetch(`${harness.url}${path}`, { method })).status).toBe(200);
    }
    expect(client.recent).toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalled();
    expect(client.wakeUp).toHaveBeenCalled();
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

  /**
   * The production failure this route's classification exists to prevent, and the
   * one `instanceof` could not: a guest runs TWO copies of this SDK on purpose
   * (the harness bundles one, the agent's runtime comes from its own bundle), so
   * the copy that throws a caller mistake is not the copy that catches it.
   * `POST /workflows/runs` answered 500 to five schema failures in one production
   * day and 400 to none, while this file's own in-process case passed.
   *
   * `foreignRequestError` is what a second copy of `_workflow-request-error.ts`
   * constructs — same registered brand, different class — and the `instanceof`
   * assertion below is what keeps this test honest: without it, a guard that
   * quietly went back to `instanceof` would still pass, because the double IS a
   * `WorkflowRequestError` in every way except identity.
   */
  test("a caller mistake thrown by ANOTHER copy of the SDK is still a 400", async () => {
    const start = vi.fn(() =>
      Promise.reject(foreignRequestError('Workflow "nope" is not declared')),
    );
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "nope" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Workflow "nope" is not declared' });
    // The seam is real: this value would fail the `instanceof` the route used to
    // use, so a 400 above can only have come from the brand.
    expect(foreignRequestError("x")).not.toBeInstanceOf(WorkflowRequestError);
    // And it must not be logged as an unhandled fault — the 500 came with a
    // "Workflow API request failed" line naming a caller's typo as our bug.
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  test("a start rejected as the CALLER's mistake is a 400 carrying the client's own sentence", async () => {
    const start = vi.fn(() =>
      Promise.reject(new WorkflowRequestError('Workflow "nope" is not declared')),
    );
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "nope" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Workflow "nope" is not declared' });
  });

  // The pair below is the whole point of `WorkflowRequestError`, and the reason
  // it is a TYPE test rather than a message one. Measured against a real dead
  // database: this route answered `400 {"error":"connect ECONNREFUSED
  // 127.0.0.1:54399"}`, so a client was told its request was bad (nothing
  // retries that) and an unauthenticated caller was handed the DSN.
  test("a start rejected by the INFRASTRUCTURE is an opaque 500, not a 400", async () => {
    const start = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:54399")));
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
    });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
  });

  test("the infrastructure cause reaches the LOG and never the response body", async () => {
    const start = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:54399")));
    harness = await serve({ engine: () => fakeClient({ start }) });
    const body = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
    }).then((r) => r.text());
    expect(body).not.toContain("54399");
    expect(body).not.toContain("ECONNREFUSED");
    // `harness.logger` is this server's own, not a module singleton: shared,
    // the preceding test's identical `Workflow API request failed` call
    // satisfied this on its own, so deleting the log line left it green.
    expect(harness.logger.error).toHaveBeenCalledWith("Workflow API request failed", {
      error: "connect ECONNREFUSED 127.0.0.1:54399",
    });
  });

  test("a caller that HUNG UP is not logged as this agent's failure", async () => {
    // Node errors an aborted request stream with `aborted` / `ECONNRESET`, and
    // there is no socket left to write a 500 to. At error level these read as
    // exactly what an operator is hunting for: 30 lines of `Workflow API request
    // failed { error: 'aborted' }` in one hour of production log, every one a
    // navigation away or an upload the platform's proxy gave up on.
    const aborted = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const start = vi.fn(() => Promise.reject(aborted));
    harness = await serve({ engine: () => fakeClient({ start }) });
    await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
    }).catch(() => undefined);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expect(harness.logger.debug).toHaveBeenCalledWith(
      "Workflow API request failed (caller went away)",
      { error: "aborted" },
    );
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
    const recent = vi.fn(() =>
      Promise.reject(new WorkflowRequestError("Declared workflows: digest")),
    );
    harness = await serve({ engine: () => fakeClient({ recent }) });
    const res = await fetch(`${harness.url}/workflows/runs?workflow=nope`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Declared workflows: digest" });
  });

  // The read path leaked more than the start path did: the raw message here is
  // the driver's, so a 400 carried the entire `select … from
  // "workflow"."workflow_runs" where … limit $2` statement.
  test("a failed READ is an opaque 500 and never echoes the query", async () => {
    const recent = vi.fn(() =>
      Promise.reject(
        new Error('Failed query: select "id", "output" from "workflow"."workflow_runs" limit $2'),
      ),
    );
    harness = await serve({ engine: () => fakeClient({ recent }) });
    const res = await fetch(`${harness.url}/workflows/runs?workflow=digest`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
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

describe("POST /runs/:id/wake", () => {
  test("reports how many sleeps it interrupted", async () => {
    const wakeUp = vi.fn(async () => 2);
    harness = await serve({ engine: () => fakeClient({ wakeUp }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/wake`, { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: "wrun_1", woken: 2 });
    expect(wakeUp).toHaveBeenCalledWith("wrun_1");
  });

  test("a run that was not sleeping is 200 with 0, not an error", async () => {
    // Same rule as `cancelled: false` above: "it was already past that" is an
    // answer, and two tabs pressing the button is ordinary.
    harness = await serve({ engine: () => fakeClient({ wakeUp: vi.fn(async () => 0) }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/wake`, { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: "wrun_1", woken: 0 });
  });

  test("is matched before the POST collection route, not as a run named 'wake'", async () => {
    // `/runs` is an exact match and `/runs/:id/wake` a prefix one, so a start
    // must not be able to claim this path — the failure would be a wake request
    // silently STARTING a run.
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    await fetch(`${harness.url}/workflows/runs/wrun_1/wake`, { method: "POST" });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("GET /runs/:id/stream", () => {
  test("streams the run's written chunks, then done", async () => {
    const stream = vi.fn(async () => chunkStream([{ step: 1 }, { step: 2 }]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toBe(
      'event: chunk\ndata: {"step":1}\n\n' +
        'event: chunk\ndata: {"step":2}\n\n' +
        'event: done\ndata: {"runId":"wrun_1","complete":false}\n\n',
    );
  });

  test("ends at the TAIL rather than waiting for a close that never comes", async () => {
    // The bug this route exists in its current shape to avoid: a workflow stream
    // reports `done` only when CLOSED, and a progress channel written by
    // successive steps is never closed — so a reader that waits for the end waits
    // forever, on a finished run too. The tail is the bound instead. The fake
    // stream here never ends, which is exactly what the real one does.
    const endless = new ReadableStream<unknown>({
      pull(controller) {
        controller.enqueue("line");
      },
    });
    harness = await serve({
      engine: () => fakeClient({ stream: async () => endless, streamTail: async () => 2 }),
    });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    const body = await res.text();
    // Exactly tail + 1 chunks, then the terminator.
    expect(body.match(/event: chunk/g)).toHaveLength(3);
    expect(body).toContain("event: done");
  });

  test("a stream nothing has written answers a bare done", async () => {
    harness = await serve({
      engine: () => fakeClient({ stream: async () => chunkStream([]), streamTail: async () => -1 }),
    });
    const body = await (await fetch(`${harness.url}/workflows/runs/wrun_1/stream`)).text();
    expect(body).not.toContain("event: chunk");
    expect(body).toContain("event: done");
  });

  test("a budget of zero opens NO stream", async () => {
    // The poll a caught-up page makes once a second: `useWorkflowProgress`
    // advances `startIndex` by what it has consumed, so a run mid-step answers
    // this shape for as long as the step writes nothing. Opening a world read to
    // take no chunks from it is the read that leaked a listener pair per
    // request — see `workflow-stream-readers.test.ts`.
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream, streamTail: async () => 2 }) });
    const body = await (
      await fetch(`${harness.url}/workflows/runs/wrun_1/stream?startIndex=3`)
    ).text();
    expect(stream).not.toHaveBeenCalled();
    expect(body).not.toContain("event: chunk");
    expect(body).toContain("event: done");
  });

  test("`complete` reports the RUN's state, which is what stops a reader", async () => {
    harness = await serve({
      engine: () =>
        fakeClient({
          get: async () => run({ status: "completed", output: 1 }),
          stream: async () => chunkStream(["only"]),
          streamTail: async () => 0,
        }),
    });
    const body = await (await fetch(`${harness.url}/workflows/runs/wrun_1/stream`)).text();
    expect(body).toContain('"complete":true');
  });

  test("an unknown run is a 404 rather than an empty 200 stream", async () => {
    // The client stream is lazy, so without the read-first this would open a
    // 200 event stream and fail on the first pull — which a page cannot tell
    // apart from a dropped connection.
    const stream = vi.fn();
    harness = await serve({ engine: () => fakeClient({ get: async () => undefined, stream }) });
    const res = await fetch(`${harness.url}/workflows/runs/gone/stream`);
    expect(res.status).toBe(404);
    expect(stream).not.toHaveBeenCalled();
  });

  test("forwards namespace and startIndex, negative index included", async () => {
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    await fetch(`${harness.url}/workflows/runs/wrun_1/stream?namespace=logs&startIndex=-3`);
    expect(stream).toHaveBeenCalledWith("wrun_1", { namespace: "logs", startIndex: -3 });
  });

  test("passes no options when the query carried none", async () => {
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(stream).toHaveBeenCalledWith("wrun_1", {});
  });

  test("a non-integer startIndex is a 400", async () => {
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream?startIndex=half`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "`startIndex` must be an integer" });
  });

  test("is matched before the bare `/runs/:id` GET", async () => {
    // Same ordering hazard as `/events`: listed after the prefix rule, the whole
    // `wrun_1/stream` would be read as a run id and answer 404 for a live run.
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // `get` still runs — the route reads the run first to answer 404 honestly —
    // but with the id parsed clean of the suffix.
    expect(get).toHaveBeenCalledWith("wrun_1");
  });
});

describe("failure handling", () => {
  test("a route that throws answers 500 rather than hanging or crashing", async () => {
    const get = vi.fn(() => Promise.reject(new Error("boom")));
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
    expect(harness.logger.error).toHaveBeenCalledWith(
      "Workflow API request failed",
      expect.objectContaining({ error: "boom" }),
    );
  });
});
