// Copyright 2026 the AAI authors. MIT license.
/**
 * What `createRuntimeServer` does for a WORKFLOW APP — `workflowApp()` —
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

import { rejectingWorkflows } from "@alexkroman1/aai/internal";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { silentLogger, withDeadline } from "./_test-utils.ts";
import { createRuntimeServer, type SessionRuntime } from "./server.ts";
import { MAX_WEBHOOK_BODY_BYTES } from "./workflow-webhook.ts";

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
    signal: vi.fn(async (token: string) => token === "live"),
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
  let server: ReturnType<typeof createRuntimeServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("declines a /websocket upgrade WITH A REASON rather than dropping it", async () => {
    // A bare socket drop leaves the client reconnecting against a server that
    // will never answer, with nothing in the frame log explaining why.
    server = createRuntimeServer({
      runtime: makeRuntime(),
      page: "static",
      logger: silentLogger,
    });
    await server.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/websocket`);
    // Rejects on `close` and carries a deadline: this test's whole premise is
    // that the decline is WRITTEN before the socket goes away, so a server that
    // closed silently — or wrote nothing and held the socket — has to fail
    // naming that, not time the file out at 5 s naming nothing.
    const message = await withDeadline(
      new Promise<string>((resolve, reject) => {
        ws.on("message", (data) => resolve(String(data)));
        ws.on("error", reject);
        ws.on("close", (code) => reject(new Error(`closed (${code}) before any frame`)));
      }),
      "no frame arrived on a declined /websocket",
    );
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    expect(JSON.parse(message)).toEqual(
      expect.objectContaining({
        type: "error.reported",
        code: "protocol",
        message: expect.stringContaining("static page"),
        fatal: true,
      }),
    );
    expect(await closed).toBe(1008);
  });

  test("a voice agent's /websocket is untouched", async () => {
    const runtime = makeRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    await server.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/websocket`);
    await withDeadline(
      new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
        ws.on("close", (code) => reject(new Error(`closed (${code}) before opening`)));
      }),
      "the voice agent's /websocket never opened",
    );
    expect(runtime.startSession).toHaveBeenCalled();
    ws.close();
  });

  test("reports `page: static` in /client-config, so a browser knows before it dials", async () => {
    server = createRuntimeServer({
      runtime: makeRuntime(),
      name: "Digest",
      page: "static",
      logger: silentLogger,
    });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/client-config`);
    expect(JSON.parse(res.body)).toEqual({ name: "Digest", page: "static" });
  });

  test("states `page: voice` for a voice agent rather than leaving it absent", async () => {
    // A reader should not have to infer the front door from a missing key.
    server = createRuntimeServer({ runtime: makeRuntime(), name: "Support", logger: silentLogger });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/client-config`);
    expect(JSON.parse(res.body)).toEqual({ name: "Support", page: "voice" });
  });
});

describe("the workflow API mount", () => {
  let server: ReturnType<typeof createRuntimeServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("serves /workflows from the runtime's own client", async () => {
    server = createRuntimeServer({ runtime: makeRuntime(fakeWorkflows), logger: silentLogger });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/workflows`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ workflows: [{ name: "digest" }] });
  });

  test("an agent with no workflows answers 404 rather than claiming a surface", async () => {
    server = createRuntimeServer({ runtime: makeRuntime(), logger: silentLogger });
    await server.listen(0);
    const res = await get(`http://127.0.0.1:${server.port}/workflows`);
    expect(res.status).toBe(404);
  });

  test("reads the client PER REQUEST, so a lazily-built runtime is picked up", async () => {
    // The guest builds its runtime on the first thing that needs it, and for a
    // workflow app that first thing is a request to this API. A value captured
    // when the server was constructed would be `undefined` for its lifetime.
    let client: WorkflowClient | undefined;
    server = createRuntimeServer({ runtime: makeRuntime(() => client), logger: silentLogger });
    await server.listen(0);
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(404);
    client = fakeWorkflows();
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(200);
  });

  test("AAI_WORKFLOW_API_TOKEN in the agent env closes the surface", async () => {
    server = createRuntimeServer({
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
    server = createRuntimeServer({
      runtime: makeRuntime(fakeWorkflows),
      clientDir: process.cwd(),
      logger: silentLogger,
    });
    await server.listen(0);
    expect((await get(`http://127.0.0.1:${server.port}/workflows`)).status).toBe(200);
  });

  /**
   * The webhook route, which is the one workflow URL handed to a third party.
   *
   * It is mounted HERE — by `createRuntimeServer`, off the same lazy `runtime.workflows`
   * getter the API uses — and that is the regression. It used to be mounted by
   * `createWorkflowSurface`, gated on the DevKit's `workflowCode`/`stepCode`
   * pair; once the engine replaced the DevKit those strings stopped existing, so
   * the route was reachable from NOWHERE and every callback a deployed run had
   * handed out answered 404 forever. Nothing else could see it: the run reported
   * as healthily suspended, and the failure lands weeks later on somebody else's
   * server.
   */
  describe("the webhook route", () => {
    const hookUrl = (port: number | undefined, token: string) =>
      `http://127.0.0.1:${port}/.well-known/workflow/v1/webhook/${token}`;

    async function serveWorkflows() {
      const workflows = fakeWorkflows();
      server = createRuntimeServer({ runtime: makeRuntime(() => workflows), logger: silentLogger });
      await server.listen(0);
      const { port } = server;
      // `listen` resolved, so a port is bound. A THROW rather than an
      // `expect.fail`: this is a helper, and Biome's `noMisplacedAssertion`
      // rightly refuses an assertion outside a test body. Without it an
      // undefined builds `…/undefined/live` and every case below fails on a URL
      // nobody looks at.
      if (port === undefined) throw new Error("server bound no port");
      return { workflows, port };
    }

    test("delivers to an open hook and answers 200", async () => {
      const { workflows, port } = await serveWorkflows();
      const res = await fetch(hookUrl(port, "live"), {
        method: "POST",
        body: JSON.stringify({ approved: true }),
      });
      expect(res.status).toBe(200);
      expect(workflows.signal).toHaveBeenCalledWith("live", { approved: true });
    });

    test("a verb that carries no payload is refused, and delivers nothing", async () => {
      // The finding this replaces a test for. The route used to declare
      // `methods: "any"` — "the far side picks its own verb" — and a delivery
      // is PERMANENT: `signal` resolves the waitpoint and the hook closes. So a
      // bare `GET` from a link-preview fetcher, a URL scanner or a crawler
      // resolved the run with `{}`, and an approval workflow fired with no
      // human anywhere near it. A webhook delivery carries a payload; a verb
      // that does not carry one cannot be a delivery.
      const { workflows, port } = await serveWorkflows();
      for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
        const res = await fetch(hookUrl(port, "live"), { method });
        expect(res.status, method).toBe(405);
        // Named, so a sender that guessed wrong can correct itself rather than
        // reading the refusal as "this hook is gone".
        expect(res.headers.get("allow"), method).toBe("POST");
      }
      expect(workflows.signal).not.toHaveBeenCalled();
    });

    test("an oversized body is refused with a 413 rather than delivered", async () => {
      // The wiring half — the bound itself is `workflow-http-adapter.test.ts`,
      // which is where "refused as it arrives" is asserted. What this pins is
      // that the SERVER declares a cap at all: the route is the one public,
      // unauthenticated door in the product, so an absent cap is an attacker
      // choosing how much of this process's memory to spend.
      const { workflows, port } = await serveWorkflows();
      const res = await fetch(hookUrl(port, "live"), {
        method: "POST",
        body: "a".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
      });
      expect(res.status).toBe(413);
      expect(workflows.signal).not.toHaveBeenCalled();
    });

    test("a token nothing is listening on answers 404, never a 5xx", async () => {
      // The caller is a third party with a retry loop, and a 5xx tells that loop
      // to come back — so an expired callback was retried against an error
      // forever. 404 is what stops it, and it is stable: a closed hook does not
      // reopen.
      const { port } = await serveWorkflows();
      const res = await fetch(hookUrl(port, "gone"), { method: "POST" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No workflow hook for this token" });
    });

    test("an agent that declares no workflows answers 404 rather than 500", async () => {
      server = createRuntimeServer({ runtime: makeRuntime(), logger: silentLogger });
      await server.listen(0);
      expect((await fetch(hookUrl(server.port, "live"), { method: "POST" })).status).toBe(404);
    });

    test("answers a malformed token instead of killing the process", async () => {
      // The regression for the worst finding of the 2026-08 sweep: a raw `%`
      // clears the ""/"/" guards and reached `decodeURIComponent`, whose URIError
      // surfaced as an uncaughtException — `process.exit(4)` in the guest, taking
      // every concurrent voice session with it, from an unauthenticated GET.
      // Driven through a real server because an ANSWER is the proof: a throw here
      // destroys the socket rather than answering.
      const { workflows, port } = await serveWorkflows();
      for (const token of ["%", "%A", "%zz", "%C0%80"]) {
        const res = await fetch(hookUrl(port, token));
        expect(res.status, token).toBe(404);
      }
      // Declined rather than delivered: a token nobody can decode names no run.
      expect(workflows.signal).not.toHaveBeenCalled();
    });
  });
});
