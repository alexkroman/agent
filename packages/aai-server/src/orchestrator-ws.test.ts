// Copyright 2026 the AAI authors. MIT license.
/**
 * The upgrade handler over an unlistened `http.Server`, emitting `upgrade`
 * directly with an in-memory socket — so what is asserted is the handshake
 * BYTES this module writes, with no port. The path grammar is pinned in
 * `orchestrator-security-validation.test.ts`, and the redirect against a real
 * listening server in `transport-websocket.test.ts`.
 */

import { IncomingMessage, Server } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { captureLogs } from "./_logger-test-utils.ts";
import { createTestOrchestrator } from "./_orchestrator-test-utils.ts";
import { deployAgent } from "./_request-test-utils.ts";
import { fakeSandbox } from "./_sandbox-test-utils.ts";
import type { HonoEnv } from "./context.ts";
import { createWsUpgrades, wsSlugFromPath } from "./orchestrator-ws.ts";
import type { ResolveSandboxOpts } from "./sandbox/resolve.ts";
import { createSlotCache, setSlot } from "./sandbox/slots.ts";
import type { Sandbox } from "./sandbox.ts";

/** Emit one upgrade for `url` and collect what was written before the socket closed. */
async function upgrade(broker: ResolveSandboxOpts, url: string) {
  const server = new Server();
  createWsUpgrades({
    broker,
    platformSocket: { app: new Hono<HonoEnv>(), store: broker.store },
  }).injectWebSocket(server);
  const req = new IncomingMessage(new Socket());
  req.url = url;
  const socket = new PassThrough();
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise((resolve) => socket.once("close", resolve));
  server.emit("upgrade", req, socket, Buffer.alloc(0));
  await closed;
  return Buffer.concat(chunks).toString();
}

/** A deployed `slug` whose resident sandbox is `sandbox`. */
async function residentBroker(slug: string, sandbox: Sandbox): Promise<ResolveSandboxOpts> {
  const slots = createSlotCache();
  const { fetch, store } = await createTestOrchestrator({ slots });
  await deployAgent(fetch, slug);
  setSlot(slots, { slug, sandbox, version: (await store.getAgentVersion(slug)) ?? 1 });
  return { slots, store };
}

describe("createWsUpgrades", () => {
  captureLogs();

  test("an upgrade on a path it does not own is hung up on, unanswered", async () => {
    const { store } = await createTestOrchestrator();
    expect(await upgrade({ slots: createSlotCache(), store }, "/not/a/socket/path")).toBe("");
  });

  test("an unknown slug answers a real 404 handshake", async () => {
    const { store } = await createTestOrchestrator();
    const response = await upgrade({ slots: createSlotCache(), store }, "/ghost/websocket");
    expect(response).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    expect(response).toContain("GET /ghost/client-config");
  });

  test("a plain ws: session URL is redirected with an http: Location, query kept", async () => {
    const broker = await residentBroker(
      "local",
      fakeSandbox({
        sessionUrl: vi.fn(() => Promise.resolve("ws://127.0.0.1:41234/websocket")),
        guestOrigin: vi.fn(() => Promise.resolve("ws://127.0.0.1:41234")),
      }),
    );
    const response = await upgrade(broker, "/local/websocket?sessionId=s1");
    expect(response).toMatch(/^HTTP\/1\.1 302 Found\r\n/);
    expect(response).toContain("Location: http://127.0.0.1:41234/websocket?sessionId=s1\r\n");
  });

  test("a sandbox that failed to start answers a retryable 503", async () => {
    const broker = await residentBroker(
      "broken",
      fakeSandbox({ sessionUrl: () => Promise.reject(new Error("spawn failed")) }),
    );
    expect(await upgrade(broker, "/broken/websocket")).toMatch(
      /^HTTP\/1\.1 503 Service Unavailable\r\n/,
    );
  });
});

describe("wsSlugFromPath", () => {
  test("reads the slug from a well-formed path only", () => {
    expect(wsSlugFromPath("/my-agent/websocket")).toBe("my-agent");
    expect(wsSlugFromPath("/my-agent/websocket/extra")).toBeUndefined();
  });
});
