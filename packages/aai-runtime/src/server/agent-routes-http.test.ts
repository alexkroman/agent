// Copyright 2026 the AAI authors. MIT license.
/**
 * `/api/*` as `createServerForRuntime` serves it: the prefix, the body cap, JSON
 * both ways, the headers and the raw body, `?client=`, and an agent with no routes leaving the prefix alone —
 * then once through a real `createRuntime`, to pin that `agent({ routes })` is
 * all it takes.
 */

import { type RouteHandler, routeResponse } from "@alexkroman1/aai";
import { createStubWorkflows } from "@alexkroman1/aai/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeAgent } from "../_agent-test-utils.ts";
import { silentLogger } from "../_logger-test-utils.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  FAKE_STT_API_KEY_ENV,
  FAKE_TTS_API_KEY_ENV,
  registerFakeProviders,
} from "../_pipeline-test-fakes.ts";
import { compileAgentRoutes, createRuntimeWithSeams } from "../runtime/index.ts";
import { createSessionEventStream } from "../session/index.ts";
import { createMemoryStateBackend } from "../session-state/store.ts";
import { MAX_ROUTE_BODY_BYTES } from "./agent-routes-http.ts";
import { type AgentServer, createServerForRuntime, type SessionRuntime } from "./server.ts";

// Every server a test opens — one test serves twice, so a single slot would
// orphan the first listener.
const servers: AgentServer[] = [];
let unregister: (() => void) | undefined;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  unregister?.();
});

async function serve(routes: Record<string, RouteHandler> | undefined): Promise<string> {
  const backend = createMemoryStateBackend();
  const history = { backend, stream: createSessionEventStream({ backend }) };
  const runtime: SessionRuntime = {
    startSession: () => undefined,
    shutdown: async () => undefined,
    serveRoute: compileAgentRoutes({
      routes,
      env: {},
      workflows: createStubWorkflows(),
      history,
      speech: { live: () => undefined },
      logger: silentLogger,
    }),
  };
  const server = createServerForRuntime({ runtime, logger: silentLogger });
  servers.push(server);
  await server.listen(0);
  return `http://127.0.0.1:${server.port}`;
}

describe("/api on createServerForRuntime", () => {
  test("GET /api/<path> answers the route's return value as JSON, handed ?client=", async () => {
    const handler = vi.fn<RouteHandler>((req) => ({ client: req.clientId, q: req.query.page }));
    const base = await serve({ "GET /memories": handler });
    const res = await fetch(`${base}/api/memories?client=kitchen&page=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ client: "kitchen", q: "2" });
  });

  test("a POST body arrives parsed, and one that is not JSON is a 400 before the handler", async () => {
    const handler = vi.fn<RouteHandler>((req) => req.body);
    const base = await serve({ "POST /memories": handler });
    const ok = await fetch(`${base}/api/memories`, { method: "POST", body: '{"text":"milk"}' });
    expect(await ok.json()).toEqual({ text: "milk" });
    const bad = await fetch(`${base}/api/memories`, { method: "POST", body: "milk" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Request body is not JSON" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("headers arrive lower-cased as plain strings, and rawBody is the exact bytes sent", async () => {
    const handler = vi.fn<RouteHandler>(() => routeResponse(204));
    const base = await serve({ "POST /webhooks/composio": handler });
    // Whitespace, key order and a number spelling JSON.stringify(body) would not reproduce.
    const sent = '{ "b":1,\n\t"a" : [ 1.50 , "é" ] }\n';
    const res = await fetch(`${base}/api/webhooks/composio`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Webhook-Id": "msg_1",
        "WEBHOOK-TIMESTAMP": "1700000000",
        "webhook-signature": "v1,abc=",
      },
      body: sent,
    });
    expect(res.status).toBe(204);
    const [req] = handler.mock.calls[0] ?? [];
    expect(req?.rawBody).toBe(sent);
    expect(req?.rawBody).not.toBe(JSON.stringify(req?.body));
    expect(req?.body).toEqual({ b: 1, a: [1.5, "é"] });
    expect(req?.headers).toMatchObject({
      "content-type": "application/json",
      "webhook-id": "msg_1",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,abc=",
    });
    for (const [name, value] of Object.entries(req?.headers ?? {})) {
      expect(name).toBe(name.toLowerCase());
      expect(typeof value).toBe("string");
    }
  });

  test("a GET, or a body-less POST, has headers but no rawBody", async () => {
    const handler = vi.fn<RouteHandler>((req) => ({
      raw: "rawBody" in req,
      host: typeof req.headers.host,
    }));
    const base = await serve({ "GET /x": handler, "POST /x": handler });
    expect(await (await fetch(`${base}/api/x`)).json()).toEqual({ raw: false, host: "string" });
    const post = await fetch(`${base}/api/x`, { method: "POST" });
    expect(await post.json()).toEqual({ raw: false, host: "string" });
  });

  test("a body past the cap is a 413", async () => {
    const base = await serve({ "POST /memories": () => "unreached" });
    const res = await fetch(`${base}/api/memories`, {
      method: "POST",
      body: JSON.stringify("x".repeat(MAX_ROUTE_BODY_BYTES)),
    });
    expect(res.status).toBe(413);
  });

  test("a malformed ?client= is a 400, not a claim passed through", async () => {
    const base = await serve({ "GET /memories": () => "unreached" });
    const res = await fetch(`${base}/api/memories?client=${encodeURIComponent("a b")}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining("?client=") });
  });

  test("a 405 carries Allow, a 204 carries no body, and undefined is JSON null", async () => {
    const base = await serve({
      "DELETE /memories/:id": () => routeResponse(204),
      "GET /empty": () => undefined,
    });
    const wrong = await fetch(`${base}/api/memories/4`, { method: "PUT", body: "{}" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("DELETE");
    const gone = await fetch(`${base}/api/memories/4`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
    const none = await fetch(`${base}/api/empty`);
    expect(await none.json()).toBeNull();
  });

  test("an agent with NO routes leaves /api to the server's own 404, and /apiary is never the prefix", async () => {
    const base = await serve(undefined);
    const res = await fetch(`${base}/api/memories`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    const withRoutes = await serve({ "GET /": () => "root" });
    expect(await (await fetch(`${withRoutes}/api`)).json()).toBe("root");
    expect((await fetch(`${withRoutes}/apiary`)).status).toBe(404);
  });
});

describe("agent({ routes }) through createRuntime", () => {
  test("the declaration is all it takes: the runtime serves it, with the agent's env", async () => {
    const fakes = registerFakeProviders({
      stt: createFakeSttProvider(),
      tts: createFakeTtsProvider(),
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
    });
    unregister = fakes.unregister;
    const runtime = createRuntimeWithSeams({
      agent: makeAgent({ routes: { "GET /whoami": (_req, ctx) => ({ name: ctx.env.OWNER }) } }),
      env: {
        ...fakes.env,
        [FAKE_STT_API_KEY_ENV]: "stt-key",
        [FAKE_TTS_API_KEY_ENV]: "tts-key",
        OWNER: "Ana",
      },
      logger: silentLogger,
      stt: fakes.stt,
      llm: fakes.llm,
      tts: fakes.tts,
    });
    const server = createServerForRuntime({ runtime, logger: silentLogger });
    servers.push(server);
    await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/whoami`);
    expect(await res.json()).toEqual({ name: "Ana" });
  });

  test("a malformed route key fails createRuntime, naming the key", () => {
    expect(() =>
      createRuntimeWithSeams({
        agent: makeAgent({ routes: { "GET whoami": () => 1 } }),
        env: {},
        logger: silentLogger,
      }),
    ).toThrow('"GET whoami"');
  });
});
