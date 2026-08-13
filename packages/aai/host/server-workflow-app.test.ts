// Copyright 2026 the AAI authors. MIT license.
/**
 * What `createServer` does for a WORKFLOW APP — `workflowApp()` —
 * and how it mounts the workflow HTTP API for every agent.
 *
 * Its own file rather than more cases in `server.test.ts`: those are about the
 * voice server's own surfaces, and every test here needs a runtime carrying a
 * `workflows` client, which that file's helper deliberately does not build.
 *
 * The three properties worth pinning are the ones that are silent when wrong. A
 * static agent that still accepts `/websocket` hands a client a socket nothing
 * will answer; a `/client-config` that omits `page` leaves the default shell
 * rendering a start screen for an agent with no session; and an API mounted
 * from a captured value rather than a getter answers 404 forever on the guest,
 * whose runtime is built lazily by the first request to it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { WorkflowClient } from "../sdk/workflow.ts";
import { rejectingWorkflows } from "../sdk/workflow-unavailable.ts";
import { silentLogger } from "./_test-utils.ts";
import { createServer, type SessionRuntime } from "./server.ts";

/**
 * A `ctx.workflows` that declares one workflow and nothing else.
 *
 * Built over `rejectingWorkflows` rather than as a cast literal, which is what
 * that factory exists for: a method added to the client is covered here
 * automatically, where `as WorkflowClient` would keep compiling and leave the
 * new method `undefined` for anything that reached it.
 */
function fakeWorkflows(): WorkflowClient {
  return {
    ...rejectingWorkflows("not stubbed in this test"),
    start: vi.fn(async () => "wrun_1"),
    get: vi.fn(async () => undefined),
    find: vi.fn(async () => []),
    recent: vi.fn(async () => []),
    cancel: vi.fn(async () => false),
    listing: vi.fn(() => [{ name: "digest" }]),
  };
}

/**
 * A runtime facade. `workflows` is a GETTER so a test can assert the server
 * reads it per request — the property the guest harness depends on.
 */
function makeRuntime(workflows?: () => WorkflowClient | undefined): SessionRuntime {
  return {
    startSession: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    get workflows() {
      return workflows?.();
    },
  };
}

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

describe("a workflow app's server", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("declines a /websocket upgrade WITH A REASON rather than dropping it", async () => {
    // A bare socket drop leaves the client reconnecting against a server that
    // will never answer, with nothing in the frame log explaining why.
    server = createServer({
      runtime: makeRuntime(),
      page: "static",
      logger: silentLogger,
    });
    await server.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/websocket`);
    const message = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(String(data)));
      ws.on("error", reject);
    });
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    expect(JSON.parse(message)).toEqual({
      type: "error",
      code: "protocol",
      message: expect.stringContaining("static page"),
    });
    expect(await closed).toBe(1008);
  });

  test("a voice agent's /websocket is untouched", async () => {
    const runtime = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/websocket`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    expect(runtime.startSession).toHaveBeenCalled();
    ws.close();
  });

  test("reports `page: static` in /client-config, so a browser knows before it dials", async () => {
    server = createServer({
      runtime: makeRuntime(),
      name: "Digest",
      page: "static",
      logger: silentLogger,
    });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/client-config`);
    expect(JSON.parse(res.body)).toEqual({ name: "Digest", page: "static" });
  });

  test("omits `page` for a voice agent — absent already reads as voice", async () => {
    server = createServer({ runtime: makeRuntime(), name: "Support", logger: silentLogger });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/client-config`);
    expect(JSON.parse(res.body)).toEqual({ name: "Support" });
  });
});

describe("the workflow API mount", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("serves /workflows from the runtime's own client", async () => {
    server = createServer({ runtime: makeRuntime(fakeWorkflows), logger: silentLogger });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/workflows`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ workflows: [{ name: "digest" }] });
  });

  test("an agent with no workflows answers 404 rather than claiming a surface", async () => {
    server = createServer({ runtime: makeRuntime(), logger: silentLogger });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/workflows`);
    expect(res.status).toBe(404);
  });

  test("reads the client PER REQUEST, so a lazily-built runtime is picked up", async () => {
    // The guest builds its runtime on the first thing that needs it, and for a
    // workflow app that first thing is a request to this API. A value captured
    // when the server was constructed would be `undefined` for its lifetime.
    let client: WorkflowClient | undefined;
    server = createServer({ runtime: makeRuntime(() => client), logger: silentLogger });
    await server.listen(0);
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(404);
    client = fakeWorkflows();
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(200);
  });

  test("AAI_WORKFLOW_API_TOKEN in the agent env closes the surface", async () => {
    server = createServer({
      runtime: makeRuntime(fakeWorkflows),
      env: { AAI_WORKFLOW_API_TOKEN: "s3cret" },
      logger: silentLogger,
    });
    await server.listen(0);
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${server.port}/workflows`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  test("a client asset named `workflows` cannot shadow the API", async () => {
    // Mounted before static serving, deliberately.
    server = createServer({
      runtime: makeRuntime(fakeWorkflows),
      clientDir: process.cwd(),
      logger: silentLogger,
    });
    await server.listen(0);
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(200);
  });
});
