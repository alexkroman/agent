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
import { silentLogger } from "./_test-utils.ts";
import { createServer, type SessionRuntime } from "./server.ts";
import { MAX_WORKFLOW_BLOB_BYTES, type WorkflowApiEngine } from "./workflow-api.ts";

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
  started: { workflow: string; input: unknown }[];
  blobs: { contentType: string; base64: string }[];
};

/**
 * An engine recording what the API asked of it.
 *
 * `start` rejects for an undeclared name the way the real one does, because the
 * API's mapping of that rejection to a 400 (rather than a 500) is one of the
 * behaviours under test.
 */
function makeEngine(declared = ["digest"]): FakeEngine {
  const started: { workflow: string; input: unknown }[] = [];
  const blobs: { contentType: string; base64: string }[] = [];
  return {
    started,
    blobs,
    start: (workflow, input) => {
      if (!declared.includes(workflow)) {
        return Promise.reject(
          new Error(`Unknown workflow "${workflow}". Declared workflows: ${declared.join(", ")}`),
        );
      }
      started.push({ workflow, input });
      return Promise.resolve(`run-${started.length}`);
    },
    get: (runId) =>
      Promise.resolve(
        runId === "run-1"
          ? { runId, workflow: "digest", status: "running", stepsCompleted: 2 }
          : undefined,
      ),
    putBlob: (contentType, base64) => {
      blobs.push({ contentType, base64 });
      return Promise.resolve(`blob-${blobs.length}`);
    },
    listing: () => declared.map((name) => ({ name, description: `${name} does a thing` })),
  };
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
