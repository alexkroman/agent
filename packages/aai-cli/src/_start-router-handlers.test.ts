// Copyright 2026 the AAI authors. MIT license.
/**
 * The router's two handlers driven in-process, with no socket bound: a real
 * `IncomingMessage`/`ServerResponse` pair over an unconnected socket, and an
 * injected upstream `request`. The same paths over real sockets are in
 * `_start-router.scenario.test.ts`.
 */

import type http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createRouter, type UpstreamRequest } from "./_start-router.ts";
import { clientFor } from "./_start-test-utils.ts";
import type { Admission, PrimaryMessage, ReadyWorker } from "./_start-workers.ts";

/** A request as the server's parser would hand it over, body already ended. */
function incoming(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = url;
  req.httpVersion = "1.1";
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flat();
  req.push(null);
  return req;
}

/** A response whose status, headers and body a test can read back. */
function outgoing(req: IncomingMessage) {
  const res = new ServerResponse(req);
  const body: string[] = [];
  vi.spyOn(res, "write").mockImplementation((chunk: unknown) => {
    body.push(String(chunk));
    return true;
  });
  const ended = new Promise<void>((resolve) => {
    vi.spyOn(res, "end").mockImplementation((chunk?: unknown) => {
      if (chunk !== undefined && typeof chunk !== "function") body.push(String(chunk));
      resolve();
      return res;
    });
  });
  return { res, body, ended };
}

const sentTo: PrimaryMessage[][] = [];
function readyWorker(slot: number): ReadyWorker {
  sentTo[slot] = [];
  return {
    port: 7000 + slot,
    worker: { pid: slot, kill: () => undefined, send: (message) => sentTo[slot]?.push(message) },
  };
}

/** An upstream that answers `status` with `text`, recording the options it was dialled with. */
function upstreamAnswering(status: number, text: string, headers: Record<string, string> = {}) {
  const dialled: http.RequestOptions[] = [];
  const request: UpstreamRequest = (options, onReply) => {
    dialled.push(options);
    const body = new PassThrough();
    queueMicrotask(() => {
      const reply = new IncomingMessage(new Socket());
      reply.statusCode = status;
      reply.statusMessage = "S";
      reply.headers = headers;
      reply.push(text);
      reply.push(null);
      onReply(reply);
    });
    return body;
  };
  return { request, dialled };
}

describe("createRouter — HTTP", () => {
  test("proxies to the client's worker's private port, dropping hop-by-hop headers", async () => {
    const workers = [readyWorker(0), readyWorker(1)];
    const up = upstreamAnswering(201, "made", { connection: "keep-alive", "x-kept": "yes" });
    const server = createRouter({ slots: 2, target: (s) => workers[s], request: up.request });
    const client = clientFor(1, 2);
    const req = incoming(`/api/x?client=${client}`, {
      host: "h",
      connection: "keep-alive",
      "x-app": "1",
    });
    const { res, body, ended } = outgoing(req);
    const writeHead = vi.spyOn(res, "writeHead");
    server.emit("request", req, res);
    await ended;
    expect(up.dialled[0]).toMatchObject({
      host: "127.0.0.1",
      port: 7001,
      method: "GET",
      path: `/api/x?client=${client}`,
      headers: { host: "h", "x-app": "1" },
    });
    expect(up.dialled[0]?.headers).not.toHaveProperty("connection");
    expect(writeHead).toHaveBeenCalledWith(201, "S", { "x-kept": "yes" });
    expect(body.join("")).toBe("made");
  });

  test("an upstream failure answers 502", async () => {
    const workers = [readyWorker(0)];
    const request: UpstreamRequest = () => {
      const body = new PassThrough();
      queueMicrotask(() => body.emit("error", new Error("ECONNREFUSED")));
      return body;
    };
    const server = createRouter({ slots: 1, target: (s) => workers[s], request });
    const req = incoming("/health");
    const { res, ended } = outgoing(req);
    const writeHead = vi.spyOn(res, "writeHead");
    server.emit("request", req, res);
    await ended;
    expect(writeHead).toHaveBeenCalledWith(502, { "content-type": "text/plain" });
  });

  test("no listening worker answers 503 with Retry-After", async () => {
    const server = createRouter({ slots: 2, target: () => undefined });
    const req = incoming("/health");
    const { res, ended } = outgoing(req);
    const writeHead = vi.spyOn(res, "writeHead");
    server.emit("request", req, res);
    await ended;
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ "retry-after": "1" }));
  });

  test("a client that goes away mid-request stops the upstream request", async () => {
    const workers = [readyWorker(0)];
    let upstream: PassThrough | undefined;
    const request: UpstreamRequest = () => {
      upstream = new PassThrough();
      return upstream;
    };
    const server = createRouter({ slots: 1, target: (s) => workers[s], request });
    const req = incoming("/workflows/runs/r1/events");
    const res = new ServerResponse(req);
    server.emit("request", req, res);
    res.emit("close");
    expect(upstream?.destroyed).toBe(true);
  });
});

describe("createRouter — upgrades", () => {
  test("hands the socket and the replayed head to the client's worker", () => {
    const workers = [readyWorker(0), readyWorker(1), readyWorker(2)];
    const server = createRouter({ slots: 3, target: (s) => workers[s] });
    const client = clientFor(2, 3);
    const req = incoming(`/websocket?client=${client}`, { host: "h", upgrade: "websocket" });
    const socket = new Socket();
    server.emit("upgrade", req, socket, Buffer.from("tail"));
    const handoff = sentTo[2]?.[0];
    expect(handoff?.type).toBe("aai-start:upgrade");
    if (handoff?.type !== "aai-start:upgrade") throw new Error("no handoff");
    expect(Buffer.from(handoff.bytes).toString("latin1")).toBe(
      `GET /websocket?client=${client} HTTP/1.1\r\nhost: h\r\nupgrade: websocket\r\n\r\ntail`,
    );
    expect(handoff.call).toBe(true);
    socket.destroy();
  });

  test("an upgrade with no listening worker is refused with 503", () => {
    const server = createRouter({ slots: 1, target: () => undefined });
    const socket = new Socket();
    const end = vi.spyOn(socket, "end").mockImplementation(() => socket);
    server.emit("upgrade", incoming("/websocket"), socket, Buffer.alloc(0));
    expect(String(end.mock.calls[0]?.[0])).toMatch(/^HTTP\/1\.1 503 Service Unavailable/);
    socket.destroy();
  });
});

describe("createRouter — admission", () => {
  function upgradeTo(url: string, admitCall: (slot: number, resume: boolean) => Admission) {
    sentTo.length = 0;
    const workers = [readyWorker(0)];
    const server = createRouter({ slots: 1, target: (s) => workers[s], admitCall });
    const socket = new Socket();
    const end = vi.spyOn(socket, "end").mockImplementation(() => socket);
    server.emit("upgrade", incoming(url, { host: "h" }), socket, Buffer.alloc(0));
    socket.destroy();
    const handoff = sentTo[0]?.[0];
    return {
      handedOff: handoff !== undefined,
      call: handoff?.type === "aai-start:upgrade" ? handoff.call : undefined,
      refusal: String(end.mock.calls[0]?.[0] ?? ""),
    };
  }

  test("a NEW call is refused with the reason while draining or full", () => {
    const draining = upgradeTo("/websocket?client=c", () => "draining");
    expect(draining.handedOff).toBe(false);
    expect(draining.refusal).toMatch(/503 Service Unavailable[\s\S]*draining/);
    const full = upgradeTo("/websocket?client=c", () => "full");
    expect(full.refusal).toMatch(/call limit/);
  });

  test("the admission check is told whether the call claims to resume", () => {
    const seen: boolean[] = [];
    const record = (_slot: number, resume: boolean) => {
      seen.push(resume);
      return "ok" as const;
    };
    upgradeTo("/websocket?client=c", record);
    upgradeTo("/websocket?client=c&sessionId=s1", record);
    expect(seen).toEqual([false, true]);
  });

  test("an /inbox socket is not a call: never checked, never refused, handed off as no call", () => {
    const inbox = upgradeTo("/inbox?client=c", () => "full");
    expect(inbox.handedOff).toBe(true);
    expect(inbox.call).toBe(false);
  });

  test("a prefix spelling the server routes as a session is a call: admission-checked, counted", () => {
    expect(upgradeTo("/websocket/x?client=c", () => "full").handedOff).toBe(false);
    // Handed off as a call, so the worker's drain waits for it.
    expect(upgradeTo("/websocket/x?client=c", () => "ok").call).toBe(true);
  });

  test("every call socket is put to admission (which counts it), a reconnect included", () => {
    const asked: number[] = [];
    const record = (slot: number) => {
      asked.push(slot);
      return "ok" as const;
    };
    upgradeTo("/websocket?client=c", record);
    upgradeTo("/websocket?client=c&sessionId=s1", record);
    upgradeTo("/inbox?client=c", record);
    expect(asked).toEqual([0, 0]);
  });
});

describe("createRouter — GET /workers", () => {
  function getWorkers(remoteAddress: string) {
    const status = [{ slot: 0, pid: 1, state: "serving" as const, calls: 3, elu: 0.2 }];
    const server = createRouter({ slots: 1, target: () => undefined, status: () => status });
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = "/workers";
    req.push(null);
    const { res, body, ended } = outgoing(req);
    const writeHead = vi.spyOn(res, "writeHead");
    server.emit("request", req, res);
    return { ended, body, writeHead, socket };
  }

  test("answers loopback with every worker's state", async () => {
    const run = getWorkers("127.0.0.1");
    await run.ended;
    expect(run.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
    expect(JSON.parse(run.body.join(""))).toEqual({
      workers: [{ slot: 0, pid: 1, state: "serving", calls: 3, elu: 0.2 }],
    });
    run.socket.destroy();
  });

  test("is invisible to anyone else", async () => {
    const run = getWorkers("203.0.113.9");
    await run.ended;
    expect(run.writeHead).toHaveBeenCalledWith(404);
    run.socket.destroy();
  });
});

describe("createRouter — readiness", () => {
  async function probe(method: string, url: string, notReady: string | undefined) {
    const workers = [readyWorker(0)];
    const up = upstreamAnswering(200, "ok");
    const server = createRouter({
      slots: 1,
      target: (s) => workers[s],
      request: up.request,
      notReady: () => notReady,
    });
    const req = incoming(url);
    req.method = method;
    const { res, body, ended } = outgoing(req);
    const writeHead = vi.spyOn(res, "writeHead");
    server.emit("request", req, res);
    await ended;
    return { writeHead, body: body.join(""), proxied: up.dialled.length > 0 };
  }

  test("while not ready, the primary answers a GET or HEAD /health itself with 503 and why", async () => {
    const get = await probe("GET", "/health", "server is draining");
    expect(get.proxied).toBe(false);
    expect(get.writeHead).toHaveBeenCalledWith(
      503,
      expect.objectContaining({ "retry-after": "1" }),
    );
    expect(get.body).toBe("server is draining\n");
    expect((await probe("HEAD", "/health", "server is starting")).proxied).toBe(false);
  });

  test("other requests still route while not ready; /health routes once ready", async () => {
    expect((await probe("GET", "/api/x", "server is draining")).proxied).toBe(true);
    expect((await probe("POST", "/health", "server is draining")).proxied).toBe(true);
    expect((await probe("GET", "/health", undefined)).proxied).toBe(true);
  });
});
