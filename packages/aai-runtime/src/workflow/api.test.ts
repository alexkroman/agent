// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the workflow HTTP API's five RUN endpoints — start, list, read,
 * cancel, wake. The output stream route is `api/stream.test.ts`.
 *
 * Driven through a REAL `node:http` server rather than fake request/response
 * objects, because half of what these routes decide is HTTP: the status code a
 * caller's mistake gets (400, never 500), the one a body over the cap gets (413,
 * from the router rather than the route), and the fact that a claimed request
 * always receives exactly one answer.
 *
 * The engine is `ctx.workflows` unchanged, so the double here is a plain
 * `WorkflowClient` — which is the assertion this file makes by construction: a
 * route that needed more than a client would not compile.
 *
 * The harness lives in `workflow/api/_test-utils.ts`, shared with
 * `workflow/api/sync.test.ts` (the `?wait=` mode) and
 * `workflow/api/router.test.ts` (the router's own decisions — claiming, the
 * token gate, engine resolution, route ordering, the catch). Both splits were
 * made at the 700-line test cap.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkflowRequestError } from "./_request-error.ts";
import { fakeClient, type Harness, run, serve } from "./api/_test-utils.ts";
import { MAX_WORKFLOW_KEY_LENGTH } from "./api/runs.ts";
import { MAX_WORKFLOW_INPUT_BYTES } from "./api.ts";

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
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
   * An unknown top-level key is REFUSED, and the alternative was the worst of
   * the three.
   *
   * The FAILING observation: the handler destructures `{ workflow, input, key,
   * wait }` and drops everything else, so `POST /runs` answered **202** to a body
   * carrying `notify: true` — a real `StartOptions` field this route does not
   * serve — and did not notify. A caller misspelling `key` as `keys` is indexed
   * under nothing and finds no run later, with a 202 in hand and nothing to
   * read. Silent-drop is indistinguishable from success at every level a caller
   * can look at.
   *
   * The cost of refusing is stated rather than hidden: a client sending a field
   * a NEWER server understands now gets a 400 from an older one, where before it
   * degraded to a working request minus the extra. That trade is taken because
   * every caller of this route in the tree goes through
   * `createWorkflowApiClient`, which sends exactly these four keys — so the
   * refusal has no reachable false positive today, and a future field is a
   * server change that ships with the client that sends it.
   */
  test("a body carrying an unknown key is REFUSED, not accepted and dropped", async () => {
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", notify: true }),
    });
    expect(res.status).toBe(400);
    // The message NAMES the key, because the whole failure this replaces is a
    // caller unable to see which of its fields went nowhere.
    expect(((await res.json()) as { error: string }).error).toContain("notify");
    expect(start).not.toHaveBeenCalled();
  });

  test("a body that is not an OBJECT is a 400 rather than a body naming no workflow", async () => {
    // `JSON.parse("[1,2]")` succeeds and destructures to all-undefined, so an
    // array used to reach the `workflow` check and be reported as a missing
    // field. The key check above has to see a record before it can talk about
    // its keys, which is what makes this its own answer.
    harness = await serve({ engine: () => fakeClient() });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify([1, 2]),
    });
    expect(res.status).toBe(400);
  });

  /**
   * The correlation key is BOUNDED, and it is not logged.
   *
   * Two FAILING observations on one field. `key` was length-unbounded — capped
   * only by `MAX_WORKFLOW_INPUT_BYTES`, so a 64 kB key was accepted, written to
   * the `aai_workflow_run_keys` index and indexed there — and it was written to
   * the operator's log verbatim, on a surface that is OPEN unless the operator
   * sets `AAI_WORKFLOW_API_TOKEN`. A caller-controlled string of unbounded
   * length in a log line is an unbounded write; that the same string is
   * routinely a phone number (`StartOptions.key`'s own example) makes it a
   * retention question as well. `runId` is beside it and is the identifier every
   * later line of the run carries, and `GET /runs?workflow=&key=` is what
   * answers "which run belongs to this key" — so the log loses nothing it was
   * the only source of.
   */
  test("a key past the cap is a 400 rather than an unbounded index write", async () => {
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", key: "k".repeat(MAX_WORKFLOW_KEY_LENGTH + 1) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("key");
    expect(start).not.toHaveBeenCalled();
  });

  test("a key AT the cap is accepted — the bound has to admit the longest legal one", async () => {
    const key = "k".repeat(MAX_WORKFLOW_KEY_LENGTH);
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", key }),
    });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledWith("digest", undefined, { key });
  });

  test("the caller's key never reaches the log", async () => {
    const start = vi.fn(async () => "wrun_9");
    harness = await serve({ engine: () => fakeClient({ start }) });
    await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", key: "+15550001111" }),
    });
    // The opening line still names the run — that is what every later line is
    // read against — and it carries nothing the caller wrote.
    expect(harness.logger.info).toHaveBeenCalledWith("Workflow run started", {
      workflow: "digest",
      runId: "wrun_9",
    });
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
    // `undefined` rather than no second argument at all: a BARE wake is what
    // deliberately cannot reach a `hookTimeout`, so the absence has to be
    // passed on rather than lost — see the ids case below.
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", undefined);
  });

  /**
   * The FAILING observation, and the most consequential defect on this surface:
   * the handler called `ctx.engine.wakeUp(runId)` against a signature of
   * `wakeUp(runId, options?: WakeUpOptions)`, so **the correlation ids were
   * discarded**. Two consequences, the second sharper than the first. A caller
   * asking to end one particular wait ended every `sleep` on the run. And
   * because a BARE wake deliberately cannot reach `kind: "hookTimeout"` (the
   * journal filters it — `workflow/journal/conformance-waits.ts`, "a bare wake reaches
   * ordinary sleeps and NOT a hook's deadline", written after journaling a hook
   * deadline as an ordinary sleep let one `wakeUp()` close every approval
   * window on a run), a hook's approval deadline could not be cut short over
   * HTTP AT ALL — there was no reachable spelling of the request.
   *
   * Named ids DO reach a `hookTimeout`, and that is the journal's own rule
   * rather than a widening added here: `wakeSleeps(runId, ["review"])` counts a
   * wait declared `correlationId: "review"` whatever its kind. The exclusion is
   * scoped to the bare call because a bare call is the blunt "send it now"
   * button, where closing an approval window is a SIDE EFFECT; naming the id of
   * the wait you mean is not a side effect, it is the caller identifying exactly
   * one wait. So the narrow, explicit spelling is the query parameter, and the
   * blunt one still cannot reach a deadline.
   */
  test("passes the caller's correlation ids through to the engine", async () => {
    const wakeUp = vi.fn(async () => 1);
    harness = await serve({ engine: () => fakeClient({ wakeUp }) });
    const res = await fetch(
      `${harness.url}/workflows/runs/wrun_1/wake?correlationId=review&correlationId=audit`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", { correlationIds: ["review", "audit"] });
  });

  test("a BLANK correlation id is refused rather than read as `no id`", async () => {
    // The journal is explicit that an empty-string id is not the same as none —
    // two backends used to fold them together and woke every uncorrelated sleep
    // on the run. `?correlationId=` is a caller that meant to send one and sent
    // nothing, so it is a malformed request, not a bare wake.
    const wakeUp = vi.fn(async () => 1);
    harness = await serve({ engine: () => fakeClient({ wakeUp }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/wake?correlationId=`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(wakeUp).not.toHaveBeenCalled();
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
