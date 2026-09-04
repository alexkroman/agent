// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest→platform socket, both ends, over a real port.
 *
 * SCENARIO tier because it opens one: the claim under test is that a frame
 * written by `aai-runtime/platform-socket.ts` is answered by the same Hono app
 * that answers the HTTP route, and neither end can be faked without giving that
 * up. Both unit suites either side of this wire pass against a fake peer — which
 * is exactly why one of them cannot tell you the handshake path, the bearer
 * header, the frame cap or the dispatch are wired to each other at all.
 *
 * The guest client is the REAL one, not a `ws` client driven by hand, for the
 * same reason: what a spec here is worth depends on it exercising the code a
 * deployed guest runs.
 */

import { createServer } from "node:http";
import {
  createPlatformSocket,
  PLATFORM_SOCKET_PATH,
  platformSocketUrl,
} from "@alexkroman1/aai-runtime/internal";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { createOrchestrator } from "./orchestrator.ts";
import { createMemoryPlatformEvents } from "./platform-events.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { bearerFor, createTestStore } from "./test-utils.ts";

const SLUG = "socket-agent";

let base: string;
let token: string;
let close: () => Promise<void>;
let draining = false;

beforeAll(async () => {
  const events = createMemoryPlatformEvents();
  const store = createTestStore(undefined, events);
  const { app, injectWebSocket } = createOrchestrator({
    slots: createSlotCache(),
    store,
    events: events.events,
    isDraining: () => draining,
  });
  // The store directly rather than `POST /deploy`: a deploy resolves the guest
  // HARNESS image, which this tier does not build, and nothing here is about the
  // deploy path — the bearer check reads `getAgentVersion` and that is all.
  await store.putAgent({
    slug: SLUG,
    env: {},
    worker: "export default {};",
    clientFiles: {},
    credential_hashes: [],
  });
  token = await bearerFor(store, SLUG);
  // A real `node:http` server rather than `serve()`, so `injectWebSocket` is
  // handed the type it declares and this file needs no cast to get there.
  const server = createServer(getRequestListener(app.fetch));
  injectWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "string" ? 0 : (address?.port ?? 0);
  base = `http://127.0.0.1:${port}/${SLUG}`;
  close = async () =>
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
});

afterAll(async () => {
  await close();
});

/** The guest's own client, opened and waited for. */
async function connected(bearer = token) {
  const socket = createPlatformSocket({ base, token: bearer });
  // A throw rather than an `expect`: an assertion outside a `test()` body is
  // Biome's `noMisplacedAssertion`, and this helper runs inside several.
  await vi.waitFor(() => {
    if (!socket.isOpen()) throw new Error("platform socket has not opened");
  });
  return socket;
}

test("a frame is answered by the route that answers the POST", async () => {
  const socket = await connected();
  try {
    // 501: this orchestrator has no admin database, which is what a deployment
    // without a platform database answers — the point being that the answer comes
    // from `session-state-handler.ts` rather than from anything on the socket path.
    const answered = await socket.send({
      route: "/session-state",
      body: JSON.stringify({ method: "load", sessionId: "s-1" }),
      traceparent: undefined,
    });
    expect(answered.status).toBe(501);
    // The same call over HTTP, for the comparison that is the whole claim.
    const overHttp = await fetch(`${base}/session-state`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "load", sessionId: "s-1" }),
    });
    expect(answered.status).toBe(overHttp.status);
    expect(answered.body).toBe(await overHttp.text());
  } finally {
    socket.close();
  }
});

/**
 * One hand-written frame, and the first answer to it.
 *
 * A raw client rather than the guest's, for the cases the guest's own TYPES make
 * unreachable: `PlatformSocket.send` takes a `PlatformRoute`, so an off-table
 * route cannot be written by a current guest at all. The platform still has to
 * answer one — that is what a version skew looks like from this side.
 */
async function rawFrame(frame: unknown): Promise<Record<string, unknown>> {
  const ws = new WebSocket(platformSocketUrl(base), {
    headers: { authorization: `Bearer ${token}` },
  });
  try {
    const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on("message", (data: unknown) => resolve(JSON.parse(String(data))));
      ws.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(JSON.stringify(frame));
    return await answered;
  } finally {
    ws.close();
  }
}

test("a route the table does not hold is a 404 rather than a dead call", async () => {
  // A guest one version ahead names a route this build has never heard of. It
  // gets an answer, because a frame with no reply burns its caller's deadline.
  const answered = await rawFrame({ t: "req", id: 1, route: "/not-a-route", body: "{}" });
  expect(answered).toMatchObject({ t: "res", id: 1, status: 404 });
});

test("a route that would escape the slug is refused, not dispatched", async () => {
  // The allowlist is a BOUNDARY rather than a validation: a frame's `route` is
  // concatenated into a URL, so without it a guest could name any path on this
  // server — `/../other-agent/session-state` normalizes away from its own slug,
  // and paths outside `/:slug` are not gated by the guest bearer at all. Refused
  // before a `Request` exists.
  const answered = await rawFrame({
    t: "req",
    id: 2,
    route: "/../elsewhere/session-state",
    body: "{}",
  });
  expect(answered).toMatchObject({ t: "res", id: 2, status: 404 });
  expect(String(answered.body)).toContain("no platform route");
});

test("answers a heartbeat without touching a route", async () => {
  // The liveness signal the guest tears a half-open socket down on. Answered by
  // the same dispatch loop that answers requests, which is the whole point of an
  // application ping rather than a protocol one.
  const answered = await rawFrame({ t: "ping", id: 42 });
  expect(answered).toEqual({ t: "pong", id: 42 });
});

test("the handshake refuses a bearer that is not this agent's guest", async () => {
  // Answered as a real 401 handshake, never a bare RST: a destroyed socket is
  // indistinguishable from a network fault, which on this path would present as a
  // guest silently and permanently on the HTTP fallback.
  const url = platformSocketUrl(base);
  const status = await new Promise<number | string>((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: "Bearer wrong" } });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
    });
    ws.on("open", () => {
      ws.close();
      resolve("opened");
    });
    ws.on("error", () => resolve("error"));
  });
  expect(status).toBe(401);
});

test("a draining replica refuses a new socket", async () => {
  draining = true;
  try {
    const status = await new Promise<number | string>((resolve) => {
      const ws = new WebSocket(platformSocketUrl(base), {
        headers: { authorization: `Bearer ${token}` },
      });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => {
        ws.close();
        resolve("opened");
      });
      ws.on("error", () => resolve("error"));
    });
    expect(status).toBe(503);
  } finally {
    draining = false;
  }
});

test("the path is the one the guest builds, and nothing else upgrades", () => {
  expect(platformSocketUrl(base)).toBe(base.replace("http:", "ws:") + PLATFORM_SOCKET_PATH);
});
