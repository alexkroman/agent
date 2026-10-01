// Copyright 2026 the AAI authors. MIT license.
/**
 * `agent({ routes })`, the runtime's half: what a declaration compiles to, which
 * handler a request reaches, and what each way of answering comes back as.
 */

import { type RouteHandler, routeError, routeResponse } from "@alexkroman1/aai";
import { createStubWorkflows } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { compileAgentRoutes, type RouteCall } from "./agent-routes.ts";
import { bindClientSession, createSessionEventStream } from "./session/index.ts";
import { createMemoryStateBackend } from "./session-state/store.ts";

function compile(routes: Record<string, RouteHandler> | undefined, env = {}) {
  const backend = createMemoryStateBackend();
  const stream = createSessionEventStream({ backend });
  const logger = makeLogger();
  const history = { backend, stream, logger };
  const workflows = createStubWorkflows();
  const serve = compileAgentRoutes({
    routes,
    env,
    workflows,
    history,
    logger,
    speech: { live: () => undefined },
  });
  return { serve, logger, history, stream, workflows };
}

const call = (overrides: Partial<RouteCall> = {}): RouteCall => ({
  method: "GET",
  path: "/",
  query: {},
  body: undefined,
  signal: new AbortController().signal,
  ...overrides,
});

describe("compileAgentRoutes", () => {
  test("an agent that declares no routes has no serveRoute", () => {
    expect(compile(undefined).serve).toBeUndefined();
  });

  test("a key that is not `<METHOD> /<path>` fails the compile, naming the key", () => {
    for (const key of ["GET memories", "get /memories", "FETCH /x", "GET  /x", "/memories"]) {
      expect.soft(() => compile({ [key]: () => 1 }), key).toThrow(key);
    }
    expect(() => compile({ "GET /a/:1x": () => 1 })).toThrow(":1x");
    // A bundle's declaration crosses untyped, which is what this stands in for.
    expect(() => compile(JSON.parse('{ "GET /a": "nope" }'))).toThrow("is not a function");
  });

  test("two keys that match the same requests are refused — one could never run", () => {
    expect(() => compile({ "GET /a/:x": () => 1, "GET /a/:y/": () => 2 })).toThrow(
      "match the same requests",
    );
    // Different methods, or a literal beside a parameter, are two routes.
    expect(compile({ "GET /a/:x": () => 1, "POST /a/:y": () => 2 }).serve).toBeTypeOf("function");
  });

  test("the handler's return value is a 200, and undefined is sent as null", async () => {
    const { serve } = compile({ "GET /memories": () => [{ id: 1 }], "GET /none": () => undefined });
    expect(await serve?.(call({ path: "/memories" }))).toEqual({ status: 200, body: [{ id: 1 }] });
    expect(await serve?.(call({ path: "/none" }))).toEqual({ status: 200, body: null });
  });

  test("the request arrives parsed: params decoded, query, headers, body, rawBody and clientId", async () => {
    const handler = vi.fn<RouteHandler>(() => "ok");
    const { serve } = compile({ "POST /memories/:id": handler }, { MEMORY_URL: "http://memory" });
    await serve?.(
      call({
        method: "POST",
        path: "/memories/a%20b",
        query: { client: "kitchen", page: "2" },
        headers: { "webhook-id": "msg_1" },
        body: { text: "milk" },
        rawBody: '{ "text": "milk" }',
        clientId: "kitchen",
      }),
    );
    expect(handler).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/memories/a%20b",
        params: { id: "a b" },
        query: { client: "kitchen", page: "2" },
        headers: { "webhook-id": "msg_1" },
        body: { text: "milk" },
        rawBody: '{ "text": "milk" }',
        clientId: "kitchen",
      },
      expect.objectContaining({ env: { MEMORY_URL: "http://memory" } }),
    );
  });

  test("a call with no headers (a harness predating them) hands the handler an empty record", async () => {
    const handler = vi.fn<RouteHandler>(() => "ok");
    const { serve } = compile({ "GET /x": handler });
    await serve?.(call({ path: "/x" }));
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ headers: {} });
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("rawBody");
  });

  test("a literal segment beats a parameter, whatever order they were declared in", async () => {
    const { serve } = compile({
      "GET /memories/:id": (req) => `one ${req.params.id}`,
      "GET /memories/recent": () => "recent",
    });
    expect((await serve?.(call({ path: "/memories/recent" })))?.body).toBe("recent");
    expect((await serve?.(call({ path: "/memories/7" })))?.body).toBe("one 7");
  });

  test("an unknown path is a 404; a known path with another method is a 405 naming its methods", async () => {
    const { serve } = compile({ "GET /x": () => 1, "DELETE /x": () => 2 });
    expect(await serve?.(call({ path: "/y" }))).toEqual({
      status: 404,
      body: { error: "Not found" },
    });
    expect(await serve?.(call({ method: "POST", path: "/x" }))).toEqual({
      status: 405,
      body: { error: "/x answers GET, DELETE" },
      headers: { Allow: "GET, DELETE" },
    });
  });

  test("routeResponse answers its own status, and a throw is a 500 with the message only", async () => {
    const { serve, logger } = compile({
      "POST /made": () => routeResponse(201, { id: 3 }),
      "GET /gone": () => routeResponse(204),
      "GET /broken": () => {
        throw new Error("memory service is down");
      },
    });
    expect(await serve?.(call({ method: "POST", path: "/made" }))).toEqual({
      status: 201,
      body: { id: 3 },
    });
    expect(await serve?.(call({ path: "/gone" }))).toEqual({ status: 204, body: undefined });
    const broken = await serve?.(call({ path: "/broken" }));
    expect(broken).toEqual({ status: 500, body: { error: "memory service is down" } });
    expect(JSON.stringify(broken)).not.toContain("at ");
    expect(logger.warn).toHaveBeenCalledWith("Agent route failed", {
      route: "GET /broken",
      error: "memory service is down",
    });
  });

  test("a thrown routeError answers its own status and sentence, and is not logged as a failure", async () => {
    const { serve, logger } = compile({
      "GET /apps/:app": () => {
        throw routeError(400, "not an app name");
      },
    });
    expect(await serve?.(call({ path: "/apps/x" }))).toEqual({
      status: 400,
      body: { error: "not an app name" },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("the context carries the workflow client and the caller's signal", async () => {
    const seen = vi.fn<RouteHandler>();
    const { serve, workflows } = compile({ "GET /runs": seen });
    const controller = new AbortController();
    await serve?.(call({ path: "/runs", signal: controller.signal }));
    const ctx = seen.mock.calls[0]?.[1];
    expect(ctx?.workflows).toBe(workflows);
    expect(ctx?.signal).toBe(controller.signal);
  });

  test("ctx.clientTranscript reads THIS runtime's client log, and refuses a malformed id", async () => {
    const { serve, history, stream } = compile({
      "GET /sessions": (req, ctx) => ctx.clientTranscript(req.clientId ?? ""),
    });
    await bindClientSession(history, "route-earlier", "porch");
    stream.append("route-earlier", { type: "userTranscript.committed", text: "remind me at six" });
    const reply = await serve?.(call({ path: "/sessions", clientId: "porch" }));
    expect(reply).toMatchObject({
      status: 200,
      body: {
        sessions: [
          {
            sessionId: "route-earlier",
            messages: [{ role: "user", text: "remind me at six" }],
          },
        ],
      },
    });
    expect(await serve?.(call({ path: "/sessions" }))).toMatchObject({
      status: 500,
      body: { error: expect.stringContaining("is not a client id") },
    });
  });
});
