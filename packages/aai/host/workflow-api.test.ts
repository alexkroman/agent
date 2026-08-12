// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow HTTP API, driven over a REAL listening server.
 *
 * Real HTTP rather than a faked `req`/`res` pair, because half of what this
 * surface has to get right is at the transport level: the body cap has to refuse
 * a stream as it ARRIVES (a lying `Content-Length` must not be trusted), the
 * blob route has to carry bytes through unmangled, and the handler has to claim
 * a request exactly once even when it answers from a rejected promise. A fake
 * response object asserts none of that.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnyWorkflowDef, WorkflowRunSnapshot } from "../sdk/workflow.ts";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "../sdk/workflow-limits.ts";
import { silentLogger } from "./_test-utils.ts";
import { createServer, type SessionRuntime } from "./server.ts";
import {
  MAX_WORKFLOW_BLOB_BYTES,
  MAX_WORKFLOW_INPUT_BYTES,
  type WorkflowApiEngine,
} from "./workflow-api.ts";

/**
 * A runtime that starts no session and carries the engine under test.
 *
 * The engine is read off the RUNTIME rather than passed to `createServer`
 * separately — that is the one channel, so these tests exercise the same lookup
 * a guest's lazy facade goes through.
 */
function runtimeWith(engine?: WorkflowApiEngine | undefined): SessionRuntime {
  return {
    startSession: () => {
      throw new Error("no session should be started by a workflow API test");
    },
    ...(engine ? { workflows: engine } : {}),
    shutdown: () => Promise.resolve(),
  };
}

type FakeEngine = WorkflowApiEngine & {
  started: { workflow: string; input: unknown; key?: string | undefined }[];
  blobs: { contentType: string; base64: string }[];
  found: { workflow: string; key: string; limit?: number | undefined }[];
  /** `recent` calls — the keyless read the operator console uses. */
  listed: { workflow: string; limit?: number | undefined }[];
  /** Run ids `retry` was asked to revive. */
  revived: string[];
  /** Waitpoint tokens `signal` was presented with, and their payloads. */
  signalled: { token: string; payload: unknown }[];
  /** Scopes the API asked `scoped()` for, in order — undefined means unscoped. */
  scopes: (string | undefined)[];
};

/**
 * An engine recording what the API asked of it.
 *
 * `start` rejects for an undeclared name the way the real one does, because the
 * API's mapping of that rejection to a 400 (rather than a 500) is one of the
 * behaviours under test.
 */
function makeEngine(declared = ["digest"]): FakeEngine {
  const started: { workflow: string; input: unknown; key?: string | undefined }[] = [];
  const blobs: { contentType: string; base64: string }[] = [];
  const found: { workflow: string; key: string; limit?: number | undefined }[] = [];
  const listed: { workflow: string; limit?: number | undefined }[] = [];
  const revived: string[] = [];
  const signalled: { token: string; payload: unknown }[] = [];
  const scopes: (string | undefined)[] = [];
  const engine: FakeEngine = {
    started,
    blobs,
    found,
    listed,
    revived,
    // Both are annotated rather than contextually typed: `WorkflowClient`'s
    // methods are OVERLOADED now (a workflow may be named by its definition or by
    // a string), and TypeScript cannot infer parameter types for an arrow from an
    // overloaded target. The API only ever passes the string form.
    start: (
      workflow: AnyWorkflowDef | string,
      input?: unknown,
      options?: { key?: string },
    ): Promise<string> => {
      const name = typeof workflow === "string" ? workflow : "<by-definition>";
      if (!declared.includes(name)) {
        return Promise.reject(
          new Error(`Unknown workflow "${name}". Declared workflows: ${declared.join(", ")}`),
        );
      }
      started.push({ workflow: name, input, key: options?.key });
      return Promise.resolve(`run-${started.length}`);
    },
    get: (runId: string): Promise<WorkflowRunSnapshot | undefined> =>
      Promise.resolve(
        runId === "run-1"
          ? { runId, workflow: "digest", status: "running", stepsCompleted: 2 }
          : undefined,
      ),
    find: (
      workflow: AnyWorkflowDef | string,
      key: string,
      options?: { limit?: number },
    ): Promise<WorkflowRunSnapshot[]> => {
      const name = typeof workflow === "string" ? workflow : "<by-definition>";
      if (!declared.includes(name)) {
        return Promise.reject(
          new Error(`Unknown workflow "${name}". Declared workflows: ${declared.join(", ")}`),
        );
      }
      found.push({ workflow: name, key, limit: options?.limit });
      return Promise.resolve([
        { runId: "run-1", workflow: name, status: "completed", stepsCompleted: 1, output: 7, key },
      ]);
    },
    recent: (
      workflow: AnyWorkflowDef | string,
      options?: { limit?: number },
    ): Promise<WorkflowRunSnapshot[]> => {
      const name = typeof workflow === "string" ? workflow : "<by-definition>";
      if (!declared.includes(name)) {
        return Promise.reject(
          new Error(`Unknown workflow "${name}". Declared workflows: ${declared.join(", ")}`),
        );
      }
      listed.push({ workflow: name, limit: options?.limit });
      // No `key`, which is the case this read exists for: most runs carry none.
      return Promise.resolve([
        { runId: "run-9", workflow: name, status: "running", stepsCompleted: 3 },
      ]);
    },
    retry: (runId: string) => {
      revived.push(runId);
      return Promise.resolve(runId === "run-1");
    },
    cancel: (runId: string) => Promise.resolve(runId === "run-1"),
    putBlob: (contentType, base64) => {
      blobs.push({ contentType, base64 });
      return Promise.resolve(`blob-${blobs.length}`);
    },
    // The API never calls it; the host's idle controller does.
    busy: () => false,
    /**
     * Records the scope it was asked for and answers with the same recorder, so a
     * spec can assert both that the API scoped its engine AND what the handlers
     * then did. Returning `this`-like behaviour is right for a fake: the FILTERING
     * is the real store's job, and the property under test here is that the API
     * asks for the right scope.
     */
    scoped(scope: string | undefined) {
      scopes.push(scope);
      // No cast: `FakeEngine` extends `WorkflowApiEngine`, which already satisfies
      // the narrower scoped surface — the annotation on `engine` below is what lets
      // this self-reference type.
      return engine;
    },
    signalled,
    scopes,
    signal: (token: string, payload: unknown) => {
      signalled.push({ token, payload });
      // One token is parked; anything else is a token nothing is waiting on, which
      // is the case a retrying webhook meets routinely.
      return Promise.resolve(token === "good-token" ? "run-parked" : undefined);
    },
    listing: () => declared.map((name) => ({ name, description: `${name} does a thing` })),
  };
  return engine;
}

async function req(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; json: unknown }> {
  const res = await fetch(url, init);
  const body = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: res.status, body, json };
}

describe("workflow HTTP API", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  /** Boot a server over `engine` and resolve its base URL. */
  async function boot(
    opts: { engine?: WorkflowApiEngine | undefined; env?: Record<string, string> } = {},
  ): Promise<string> {
    server = createServer({
      runtime: runtimeWith(opts.engine),
      logger: silentLogger,
      ...(opts.env ? { env: opts.env } : {}),
    });
    await server.listen(0);
    return `http://localhost:${server.port}`;
  }

  test("lists the declared workflows", async () => {
    const base = await boot({ engine: makeEngine(["digest", "reindex"]) });
    const res = await req(`${base}/workflows`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      workflows: [
        { name: "digest", description: "digest does a thing" },
        { name: "reindex", description: "reindex does a thing" },
      ],
    });
  });

  test("starts a run and answers 202 with its id", async () => {
    const engine = makeEngine();
    const base = await boot({ engine });
    const res = await req(`${base}/workflows/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "digest", input: { topic: "ai" } }),
    });
    // 202, not 200: the run is durable and deliberately NOT finished.
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ runId: "run-1" });
    expect(engine.started).toEqual([{ workflow: "digest", input: { topic: "ai" } }]);
  });

  test("reads a run back, and 404s an unknown id", async () => {
    const base = await boot({ engine: makeEngine() });
    const found = await req(`${base}/workflows/runs/run-1`);
    expect(found.status).toBe(200);
    expect(found.json).toMatchObject({ runId: "run-1", status: "running", stepsCompleted: 2 });

    const missing = await req(`${base}/workflows/runs/nope`);
    expect(missing.status).toBe(404);
  });

  test("an undeclared workflow is the CALLER's 400, not a 500", async () => {
    const base = await boot({ engine: makeEngine(["digest"]) });
    const res = await req(`${base}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "nope" }),
    });
    expect(res.status).toBe(400);
    // The engine's message names what IS declared, which is the whole value of
    // forwarding it instead of a generic sentence.
    expect(res.body).toContain("digest");
  });

  test("a body that is not JSON, or names no workflow, is a 400", async () => {
    const base = await boot({ engine: makeEngine() });
    expect((await req(`${base}/workflows/runs`, { method: "POST", body: "not json" })).status).toBe(
      400,
    );
    expect(
      (await req(`${base}/workflows/runs`, { method: "POST", body: JSON.stringify({}) })).status,
    ).toBe(400);
  });

  test("stores an uploaded blob and reports its size", async () => {
    const engine = makeEngine();
    const base = await boot({ engine });
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const res = await req(`${base}/workflows/blobs`, {
      method: "POST",
      headers: { "Content-Type": "audio/pcm" },
      body: bytes,
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ blobId: "blob-1", bytes: 6 });
    expect(engine.blobs[0]?.contentType).toBe("audio/pcm");
    // Round-tripped byte-exactly: this path carries audio, so a UTF-8 decode
    // anywhere in it would silently replace bytes rather than fail.
    expect([...Buffer.from(engine.blobs[0]?.base64 ?? "", "base64")]).toEqual([...bytes]);
  });

  test("an empty blob is refused rather than stored", async () => {
    const engine = makeEngine();
    const base = await boot({ engine });
    const res = await req(`${base}/workflows/blobs`, { method: "POST", body: "" });
    expect(res.status).toBe(400);
    expect(engine.blobs).toEqual([]);
  });

  test("a blob past the cap is refused with 413, and nothing is stored", async () => {
    const engine = makeEngine();
    const base = await boot({ engine });
    const res = await req(`${base}/workflows/blobs`, {
      method: "POST",
      headers: { "Content-Type": "audio/pcm" },
      body: new Uint8Array(MAX_WORKFLOW_BLOB_BYTES + 1024),
    });
    // 413 rather than 400: the request was well-formed and too big, and a page
    // chunking an upload has to tell those apart.
    expect(res.status).toBe(413);
    expect(engine.blobs).toEqual([]);
  });

  test("an oversized run INPUT is 413 too, not an opaque 500", async () => {
    const engine = makeEngine();
    const base = await boot({ engine });
    // Found by driving a real server: `/blobs` mapped the over-limit rejection
    // to 413 and `/runs` did not, so a page posting too much input got
    // "Internal server error" — indistinguishable from a broken agent. The
    // mapping lives in the router for that reason, so every route that reads a
    // body inherits it; this asserts the route that did not have it.
    const res = await req(`${base}/workflows/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow: "digest",
        input: { pad: "x".repeat(MAX_WORKFLOW_INPUT_BYTES) },
      }),
    });
    expect(res.status).toBe(413);
    expect(String(res.body)).toContain(`exceeds ${MAX_WORKFLOW_INPUT_BYTES}`);
    expect(engine.started).toEqual([]);
  });

  test("the cap is counted from the STREAM, not from Content-Length", async () => {
    const engine = makeEngine();
    const base = await boot({ engine });
    // Chunked (no Content-Length at all), so nothing but counting the arriving
    // bytes can catch this — which is the point: a header a client controls is
    // not a size.
    const res = await req(`${base}/workflows/blobs`, {
      method: "POST",
      headers: { "Content-Type": "audio/pcm" },
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_WORKFLOW_BLOB_BYTES + 4096));
          controller.close();
        },
      }),
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(engine.blobs).toEqual([]);
  });

  test("a runtime that cannot BE BUILT answers 500 naming the cause", async () => {
    // Distinct from the 404 below, and the distinction was the whole bug: a
    // guest that could not build its runtime reported "declares no workflows"
    // about an app whose workflows were declared and fine, while the cause
    // reached only the guest's own log. A misconfigured agent must say so.
    server = createServer({
      runtime: {
        startSession: () => {
          throw new Error("no session should be started by a workflow API test");
        },
        // A THROWING getter is how the guest's lazy facade fails: the runtime is
        // built on first access, and that is what raises a missing key.
        get workflows(): never {
          throw new Error("AssemblyAI LLM: missing API key. Set ASSEMBLYAI_API_KEY.");
        },
        shutdown: () => Promise.resolve(),
      },
      logger: silentLogger,
    });
    await server.listen(0);
    const res = await req(`http://localhost:${server.port}/workflows`);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({
      error: "Workflow API unavailable: AssemblyAI LLM: missing API key. Set ASSEMBLYAI_API_KEY.",
    });
  });

  test("with no engine every route is a 404, not a 500", async () => {
    const base = await boot({ engine: undefined });
    expect((await req(`${base}/workflows`)).status).toBe(404);
    expect(
      (
        await req(`${base}/workflows/runs`, {
          method: "POST",
          body: JSON.stringify({ workflow: "digest" }),
        })
      ).status,
    ).toBe(404);
  });

  test("the 404 names STORAGE too, because that is the other way to have no engine", async () => {
    // `setupWorkflows` returns undefined for two reasons and the resolver
    // cannot tell them apart here, so the answer must not pick one. It used to
    // say "This app declares no workflows" — a confident false statement for
    // the common case, an agent that declared workflows and never enabled
    // storage, and one that sends its reader to audit code that is already
    // right. Asserted on the SUBSTRINGS a reader acts on rather than the whole
    // sentence, so rewording the message does not fail this.
    const base = await boot({ engine: undefined });
    const { error } = (await req(`${base}/workflows`)).json as { error: string };
    expect(error).toContain("agent({ workflows })");
    expect(error).toContain("aai storage enable");
    expect(error).toContain("DATABASE_URL");
  });

  test("that 404 is the same sentence ctx.workflows rejects with", async () => {
    // One condition, one message: the tool path and the HTTP path must not
    // disagree about why an app has no workflow engine.
    const base = await boot({ engine: undefined });
    const { error } = (await req(`${base}/workflows`)).json as { error: string };
    expect(error).toBe(WORKFLOWS_UNAVAILABLE_MESSAGE);
  });

  describe("with AAI_WORKFLOW_API_TOKEN set", () => {
    test("refuses every route without the bearer", async () => {
      const engine = makeEngine();
      const base = await boot({ engine, env: { AAI_WORKFLOW_API_TOKEN: "s3cret" } });

      expect((await req(`${base}/workflows`)).status).toBe(401);
      expect(
        (
          await req(`${base}/workflows/runs`, {
            method: "POST",
            body: JSON.stringify({ workflow: "digest" }),
          })
        ).status,
      ).toBe(401);
      expect((await req(`${base}/workflows/runs/run-1`)).status).toBe(401);
      // Nothing ran: the token is checked before the engine is even resolved, so
      // an unauthenticated caller cannot make the guest build a runtime.
      expect(engine.started).toEqual([]);
    });

    test("a wrong bearer is refused, the right one passes", async () => {
      const base = await boot({
        engine: makeEngine(),
        env: { AAI_WORKFLOW_API_TOKEN: "s3cret" },
      });
      expect(
        (await req(`${base}/workflows`, { headers: { Authorization: "Bearer wrong" } })).status,
      ).toBe(401);
      // A prefix of the real token must not pass — the length check comes first
      // precisely because `timingSafeEqual` throws on a mismatch.
      expect(
        (await req(`${base}/workflows`, { headers: { Authorization: "Bearer s3cre" } })).status,
      ).toBe(401);
      expect(
        (await req(`${base}/workflows`, { headers: { Authorization: "Bearer s3cret" } })).status,
      ).toBe(200);
    });
  });

  test("an unknown path under the prefix is a 404 from THIS handler", async () => {
    const base = await boot({ engine: makeEngine() });
    expect((await req(`${base}/workflows/nonsense`)).status).toBe(404);
  });

  test("a route that throws answers 500 once rather than hanging", async () => {
    const engine = makeEngine();
    // Reject with a non-Error to also cover `errorMessage`'s unwrapping.
    engine.get = () => Promise.reject(new Error("journal unreachable"));
    const errors = vi.fn();
    server = createServer({
      runtime: runtimeWith(engine),
      logger: { ...silentLogger, error: errors },
    });
    await server.listen(0);
    const res = await req(`http://localhost:${server.port}/workflows/runs/run-1`);
    expect(res.status).toBe(500);
    // Logged with the cause: the wire body deliberately says nothing specific.
    expect(errors).toHaveBeenCalled();
    expect(res.body).not.toContain("journal unreachable");
  });
});

describe("correlation keys over HTTP", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(engine: WorkflowApiEngine): Promise<string> {
    server = createServer({ runtime: runtimeWith(engine), logger: silentLogger });
    await server.listen(0);
    return `http://localhost:${server.port}`;
  }

  test("forwards a key from the start body", async () => {
    const engine = makeEngine();
    const base = await boot(engine);

    const res = await req(`${base}/workflows/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "digest", input: { topic: "ai" }, key: "user-9" }),
    });

    expect(res.status).toBe(202);
    expect(engine.started).toEqual([{ workflow: "digest", input: { topic: "ai" }, key: "user-9" }]);
  });

  test("refuses a non-string key rather than coercing it", async () => {
    const engine = makeEngine();
    const base = await boot(engine);

    const res = await req(`${base}/workflows/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "digest", key: 7 }),
    });

    // Coerced, `7` would be stored as "7" and never match the `find` a caller
    // writes — a silent miss rather than a reported mistake.
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: '"key" must be a string when present' });
    expect(engine.started).toEqual([]);
  });

  test("finds runs by workflow and key", async () => {
    const engine = makeEngine();
    const base = await boot(engine);

    const res = await req(`${base}/workflows/runs?workflow=digest&key=user-9&limit=3`);

    expect(res.status).toBe(200);
    expect(engine.found).toEqual([{ workflow: "digest", key: "user-9", limit: 3 }]);
    expect(res.json).toEqual({
      runs: [
        {
          runId: "run-1",
          workflow: "digest",
          status: "completed",
          stepsCompleted: 1,
          output: 7,
          key: "user-9",
        },
      ],
    });
  });

  test("retries a run through POST /runs/:id/retry", async () => {
    const engine = makeEngine();
    const base = await boot(engine);

    const res = await req(`${base}/workflows/runs/run-1/retry`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ runId: "run-1", retried: true });
    expect(engine.revived).toEqual(["run-1"]);
  });

  test("answers 200 with retried:false for a run in the wrong state", async () => {
    // Not an error: two operators pressing Retry is as ordinary as two pressing
    // Stop, and the run's state is the answer either way.
    const base = await boot(makeEngine());
    const res = await req(`${base}/workflows/runs/other/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ runId: "other", retried: false });
  });

  test("reads the id out of a retry path without swallowing the suffix", async () => {
    // The retry route matches the same prefix as `GET /runs/:id`, so its rule has
    // to be ordered first — otherwise the id would come back as "<id>/retry".
    const engine = makeEngine();
    const base = await boot(engine);
    await req(`${base}/workflows/runs/a%2Fb/retry`, { method: "POST" });
    expect(engine.revived).toEqual(["a/b"]);
  });

  test("lists a workflow's recent runs when no key is given", async () => {
    const engine = makeEngine();
    const base = await boot(engine);

    const res = await req(`${base}/workflows/runs?workflow=digest&limit=5`);

    // The OPERATOR's read (the studio's Settings pane): no key, because a console
    // has none to ask about and most runs carry none at all.
    expect(res.status).toBe(200);
    expect(engine.listed).toEqual([{ workflow: "digest", limit: 5 }]);
    // And it went to `recent`, not to `find` with a widened key — the whole
    // reason those are two methods.
    expect(engine.found).toEqual([]);
    expect(res.json).toEqual({
      runs: [{ runId: "run-9", workflow: "digest", status: "running", stepsCompleted: 3 }],
    });
  });

  test("requires the workflow parameter, key or no key", async () => {
    const engine = makeEngine();
    const base = await boot(engine);

    const missingWorkflow = await req(`${base}/workflows/runs?key=user-9`);
    const nothingAtAll = await req(`${base}/workflows/runs`);

    // `workflow` names the journal rows to read and has no default; `key` is
    // optional and selects which of the two reads runs.
    expect(missingWorkflow.status).toBe(400);
    expect(nothingAtAll.status).toBe(400);
    expect(engine.found).toEqual([]);
    expect(engine.listed).toEqual([]);
  });

  test("reports an unknown workflow as the caller's mistake", async () => {
    const base = await boot(makeEngine(["digest"]));

    const res = await req(`${base}/workflows/runs?workflow=nope&key=user-9`);

    // 400 with the engine's message, same as POST /runs — a 500 would read as
    // "the agent is broken" for a name the caller got wrong.
    expect(res.status).toBe(400);
    expect(res.body).toContain("Declared workflows: digest");
  });

  test("rejects a non-numeric limit", async () => {
    const base = await boot(makeEngine());
    const res = await req(`${base}/workflows/runs?workflow=digest&key=k&limit=lots`);
    expect(res.status).toBe(400);
  });

  test("the collection path is not mistaken for a run id", async () => {
    // `GET /workflows/runs` and `GET /workflows/runs/:id` differ by one slash, and
    // the prefix match for the latter must not swallow the former.
    const engine = makeEngine();
    const base = await boot(engine);

    await req(`${base}/workflows/runs?workflow=digest&key=k`);

    expect(engine.found).toHaveLength(1);
  });
});

describe("cancelling over HTTP", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(engine: WorkflowApiEngine): Promise<string> {
    server = createServer({ runtime: runtimeWith(engine), logger: silentLogger });
    await server.listen(0);
    return `http://localhost:${server.port}`;
  }

  test("DELETE reports that it stopped a live run", async () => {
    const base = await boot(makeEngine());
    const res = await req(`${base}/workflows/runs/run-1`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ runId: "run-1", cancelled: true });
  });

  test("DELETE on an already-finished run is 200 and false, not an error", async () => {
    const base = await boot(makeEngine());
    const res = await req(`${base}/workflows/runs/run-99`, { method: "DELETE" });

    // Two tabs pressing Stop is ordinary, and a 404 would conflate "no such run"
    // with "already done".
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ runId: "run-99", cancelled: false });
  });

  test("a cancel is refused without the API token when one is set", async () => {
    server = createServer({
      runtime: runtimeWith(makeEngine()),
      logger: silentLogger,
      env: { AAI_WORKFLOW_API_TOKEN: "secret" },
    });
    await server.listen(0);
    const base = `http://localhost:${server.port}`;

    const denied = await req(`${base}/workflows/runs/run-1`, { method: "DELETE" });
    const allowed = await req(`${base}/workflows/runs/run-1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer secret" },
    });

    // Stopping someone else's work is exactly what the token exists to gate.
    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });
});
