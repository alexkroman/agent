// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio mode's surface: its own routes, the gated control channel, and
 * everything else forwarded to the loaded bundle's server. Driven by emitting
 * on the (never-listening) server with real `node:http` objects, so no port is
 * bound.
 */

import http from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { PreviewServer, StudioPreview } from "./studio-preview.ts";
import { createStudioServer, type StudioServerDeps, startStudioTracing } from "./studio-server.ts";

const TOKEN = "t".repeat(64);

/** A real request object with the given path and bearer. */
function request(url: string, authorization?: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.url = url;
  req.method = "GET";
  if (authorization !== undefined) req.headers.authorization = authorization;
  return req;
}

/** A real response whose status and body the spec reads back. */
function response(req: http.IncomingMessage) {
  const res = new http.ServerResponse(req);
  const out = { body: "" };
  res.end = ((chunk?: unknown) => {
    out.body = typeof chunk === "string" ? chunk : "";
    return res;
  }) as typeof res.end;
  return { res, out };
}

/** A duplex standing in for an upgrade socket, recording the refusal line. */
function upgradeSocket() {
  const socket = new PassThrough();
  const sock = { written: "" };
  socket.on("data", (chunk: Buffer) => {
    sock.written += chunk.toString();
  });
  return { socket, sock };
}

/** A preview whose server is a real, unbound `node:http` server recording what it got. */
function previewWith(loaded: boolean) {
  const node = http.createServer();
  const seen: string[] = [];
  node.on("request", () => seen.push("request"));
  node.on("upgrade", () => seen.push("upgrade"));
  const server: PreviewServer = { node, close: () => Promise.resolve() };
  const preview: StudioPreview = { current: () => (loaded ? server : undefined) };
  return { preview, seen };
}

function build(overrides: Partial<StudioServerDeps> = {}) {
  const acceptControl = vi.fn();
  const server = createStudioServer({
    token: TOKEN,
    handleOwn: () => false,
    preview: previewWith(false).preview,
    hostConnected: () => false,
    acceptControl,
    ...overrides,
  });
  return { server, acceptControl };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("createStudioServer — requests", () => {
  test("before a bundle loads: /health answers 200, anything else 503", () => {
    const { server } = build();
    const healthReq = request("/health");
    const health = response(healthReq);
    server.emit("request", healthReq, health.res);
    expect(health.res.statusCode).toBe(200);
    expect(JSON.parse(health.out.body)).toEqual({ status: "ok" });

    const otherReq = request("/client-config");
    const other = response(otherReq);
    server.emit("request", otherReq, other.res);
    expect(other.res.statusCode).toBe(503);
  });

  test("the harness's own routes answer first", () => {
    const handleOwn = vi.fn(() => true);
    const { preview, seen } = previewWith(true);
    const { server } = build({ handleOwn, preview });
    const req = request("/studio/chat");
    server.emit("request", req, response(req).res);
    expect(handleOwn).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  test("everything else goes to the loaded bundle's server", () => {
    const { preview, seen } = previewWith(true);
    const { server } = build({ preview });
    const req = request("/client-config");
    server.emit("request", req, response(req).res);
    expect(seen).toEqual(["request"]);
  });
});

describe("createStudioServer — upgrades", () => {
  test("a non-control upgrade is the bundle's, or a 503 before one loads", async () => {
    const none = upgradeSocket();
    build().server.emit("upgrade", request("/websocket"), none.socket, Buffer.alloc(0));
    await flush();
    expect(none.sock.written).toContain("503");
    expect(none.socket.destroyed).toBe(true);

    const { preview, seen } = previewWith(true);
    const target = build({ preview });
    target.server.emit("upgrade", request("/websocket"), upgradeSocket().socket, Buffer.alloc(0));
    expect(seen).toEqual(["upgrade"]);
  });

  test("/ws needs the bearer, and admits one host", async () => {
    const anonymous = upgradeSocket();
    const open = build();
    open.server.emit("upgrade", request("/ws"), anonymous.socket, Buffer.alloc(0));
    await flush();
    expect(anonymous.sock.written).toContain("401");
    expect(open.acceptControl).not.toHaveBeenCalled();

    const second = upgradeSocket();
    const busy = build({ hostConnected: () => true });
    busy.server.emit("upgrade", request("/ws", `Bearer ${TOKEN}`), second.socket, Buffer.alloc(0));
    await flush();
    expect(second.sock.written).toContain("409");

    const first = build();
    first.server.emit(
      "upgrade",
      request("/ws", `Bearer ${TOKEN}`),
      upgradeSocket().socket,
      Buffer.alloc(0),
    );
    expect(first.acceptControl).toHaveBeenCalledOnce();
  });
});

describe("startStudioTracing", () => {
  test("starts the platform runtime's export, and a load failure only logs", async () => {
    const startTracingDetached = vi.fn();
    await startStudioTracing(async () => ({ startTracingDetached }));
    expect(startTracingDetached).toHaveBeenCalledOnce();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      startStudioTracing(() => Promise.reject(new Error("no tracing here"))),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no tracing here"));
    error.mockRestore();
  });
});
