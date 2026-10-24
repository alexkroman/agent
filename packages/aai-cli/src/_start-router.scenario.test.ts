// Copyright 2026 the AAI authors. MIT license.
/**
 * The `--workers` router over REAL loopback sockets: per-request HTTP proxying
 * and the upgrade handoff. Scenario tier because it binds ports.
 *
 * The "workers" here are in-process HTTP servers standing in for real ones:
 * what is under test is the router — which worker a request reaches, that a
 * keep-alive connection is routed per REQUEST, and that a handed-off upgrade
 * arrives with its request bytes intact. The cross-process half of the handoff
 * (sending the socket over IPC) is Node's, exercised by `aai start --workers`.
 */

import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { clientKey, slotOf } from "./_start-affinity.ts";
import { createRouter } from "./_start-router.ts";
import type { PrimaryMessage, ReadyWorker } from "./_start-workers.ts";

const SLOTS = 3;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  // Last in, first out: a client socket must close before the servers that wait on it.
  for (const close of closers.splice(0).reverse()) await close();
});

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    closers.push(
      () =>
        new Promise((done) => {
          if ("closeAllConnections" in server) server.closeAllConnections();
          server.close(() => done());
        }),
    );
  });
}

/**
 * A stand-in worker for `slot`: answers HTTP with its slot and the path it
 * saw, and accepts an `Upgrade: echo` by announcing its slot and echoing.
 */
async function standInWorker(slot: number): Promise<ReadyWorker> {
  const server = http.createServer((req, res) => {
    res.setHeader("x-slot", String(slot));
    res.end(JSON.stringify({ slot, url: req.url, host: req.headers.host }));
  });
  server.on("upgrade", (_req, socket: Socket, head: Buffer) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\nX-Slot: ${slot}\r\n\r\n`,
    );
    if (head.length > 0) socket.write(head);
    socket.pipe(socket);
  });
  const port = await listen(server);
  return {
    port,
    worker: {
      pid: 1000 + slot,
      kill: () => undefined,
      // What `joinCluster` does with a handoff, minus the IPC hop.
      send: (message: PrimaryMessage, socket?: Socket) => {
        if (message.type !== "aai-start:upgrade" || !socket) return;
        socket.unshift(Buffer.from(message.bytes));
        server.emit("connection", socket);
        socket.resume();
      },
    },
  };
}

async function startRouter(up: Set<number>) {
  const workers = await Promise.all([0, 1, 2].map((slot) => standInWorker(slot)));
  const router = createRouter({
    slots: SLOTS,
    target: (slot) => (up.has(slot) ? workers[slot] : undefined),
  });
  return listen(router);
}

function get(port: number, path: string, agent?: http.Agent) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path, agent }, (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        })
        .on("error", reject);
    },
  );
}

/** A client id that routes to `slot`. */
function clientFor(slot: number): string {
  for (let i = 0; ; i++) if (slotOf(clientKey(`c${i}`), SLOTS) === slot) return `c${i}`;
}

describe("the --workers router", () => {
  test("proxies each HTTP request to its client's worker, path and Host intact", async () => {
    const port = await startRouter(new Set([0, 1, 2]));
    for (const slot of [0, 1, 2]) {
      const res = await get(port, `/api/thing?client=${clientFor(slot)}`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.slot).toBe(slot);
      expect(body.url).toBe(`/api/thing?client=${clientFor(slot)}`);
      expect(body.host).toBe(`127.0.0.1:${port}`);
    }
  });

  test("routes PER REQUEST: one keep-alive connection reaches several workers", async () => {
    const port = await startRouter(new Set([0, 1, 2]));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const slots: number[] = [];
      for (const slot of [0, 1, 2, 0]) {
        const res = await get(port, `/api/x?client=${clientFor(slot)}`, agent);
        slots.push(JSON.parse(res.body).slot);
      }
      expect(slots).toEqual([0, 1, 2, 0]);
    } finally {
      agent.destroy();
    }
  });

  test("a request for a restarting worker gets 503 with Retry-After, not another worker", async () => {
    const port = await startRouter(new Set([0, 2]));
    const res = await get(port, `/api/x?client=${clientFor(1)}`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
  });

  test("hands an upgrade to its client's worker, which then owns the socket end to end", async () => {
    const port = await startRouter(new Set([0, 1, 2]));
    const client = clientFor(2);
    const socket = net.connect(port, "127.0.0.1");
    closers.push(async () => {
      socket.destroy();
    });
    socket.write(
      `GET /websocket?client=${client} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`,
    );
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    await vi.waitFor(() => expect(received).toContain("101 Switching Protocols"));
    expect(received).toContain("X-Slot: 2");
    socket.write("audio-frame-bytes");
    await vi.waitFor(() => expect(received).toContain("audio-frame-bytes"));
  });

  test("an upgrade for a restarting worker is refused with 503", async () => {
    const port = await startRouter(new Set([0, 1]));
    const socket = net.connect(port, "127.0.0.1");
    closers.push(async () => {
      socket.destroy();
    });
    socket.write(
      `GET /websocket?client=${clientFor(2)} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`,
    );
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    await vi.waitFor(() => expect(received).toContain("503 Service Unavailable"));
  });
});
