// Copyright 2026 the AAI authors. MIT license.
/**
 * A worker joining its primary: the session-id minter it installs, the relay
 * client (a notice for a client another slot owns), the owner side (a relayed
 * notice delivered here) and the upgrade handoff — through a fake link, a fake
 * server and fake runtime seams.
 */

import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import type { ClientNotifier } from "@alexkroman1/aai/host-internal";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import type { ClientNotifyRelay } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test, vi } from "vitest";
import { clientKey, sessionKey, slotOf } from "./_start-affinity.ts";
import {
  joinCluster,
  type PrimaryLink,
  requestPath,
  type WorkerRuntime,
  workflowsNeedDatabase,
} from "./_start-worker.ts";
import type { PrimaryMessage, WorkerMessage } from "./_start-workers.ts";

/** A link to a primary that records what the worker sends and lets a test speak. */
function fakeLink() {
  const sent: WorkerMessage[] = [];
  let listener: Parameters<PrimaryLink["onMessage"]>[0] = () => undefined;
  const link: PrimaryLink = {
    send: (message) => sent.push(message),
    onMessage: (next) => {
      listener = next;
    },
  };
  const deliver = (message: PrimaryMessage, socket?: Socket) => listener(message, socket);
  return { link, sent, deliver };
}

/** Runtime seams that capture what the worker installs. */
function fakeRuntime(localOutcome: Awaited<ReturnType<ClientNotifier>> = "acked") {
  const captured: {
    mint?: (() => string) | undefined;
    relay?: ClientNotifyRelay | undefined;
    delivered: string[];
  } = {
    delivered: [],
  };
  const runtime: WorkerRuntime = {
    setSessionIdMinter: (mint) => {
      captured.mint = mint;
    },
    setClientNotifyRelay: (relay) => {
      captured.relay = relay;
    },
    notifyClientHere: async (clientId) => {
      captured.delivered.push(clientId);
      return localOutcome;
    },
  };
  return { runtime, captured };
}

function fakeServer(port = 4567): AgentServer {
  const node = new EventEmitter();
  let bound: number | undefined;
  const server: Partial<AgentServer> = {
    node: node as AgentServer["node"],
    get port() {
      return bound;
    },
    async listen() {
      bound = port;
    },
  };
  return server as AgentServer;
}

/** A client id that routes to `slot` of `slots`. */
function clientFor(slot: number, slots: number): string {
  for (let i = 0; ; i++) if (slotOf(clientKey(`c${i}`), slots) === slot) return `c${i}`;
}

async function join(
  slot: number,
  slots: number,
  localOutcome?: Awaited<ReturnType<ClientNotifier>>,
) {
  const link = fakeLink();
  const { runtime, captured } = fakeRuntime(localOutcome);
  const server = fakeServer();
  await joinCluster({ slot, slots, server, name: "Agent", link: link.link, runtime });
  return { ...link, captured, server };
}

const notice = { id: "n1", event: "reminder" };

describe("joinCluster", () => {
  test("binds the private port and reports listening with the agent's name", async () => {
    const { sent } = await join(0, 2);
    expect(sent).toEqual([{ type: "aai-start:listening", name: "Agent", port: 4567 }]);
  });

  test("installs a minter whose ids route back to this slot", async () => {
    const { captured } = await join(2, 3);
    const id = captured.mint?.();
    expect(id).toBeDefined();
    expect(slotOf(sessionKey(id ?? ""), 3)).toBe(2);
  });

  test("a client this slot owns is delivered locally — the relay declines it", async () => {
    const { captured } = await join(1, 2);
    expect(captured.relay?.forward(clientFor(1, 2))).toBeUndefined();
  });

  test("a notice for another slot's client goes out as a relay, and its result settles it", async () => {
    const { captured, sent, deliver } = await join(0, 2);
    const remote = clientFor(1, 2);
    const notify = captured.relay?.forward(remote);
    const outcome = notify?.(remote, notice, { ackTimeoutMs: 1000, signal: undefined });
    const relay = sent.find((m) => m.type === "aai-start:relay");
    expect(relay).toMatchObject({ target: 1, payload: { op: "notify", clientId: remote, notice } });
    if (relay?.type !== "aai-start:relay") throw new Error("no relay sent");
    deliver({ type: "aai-start:relay-result", id: relay.id, outcome: "acked" });
    await expect(outcome).resolves.toBe("acked");
  });

  test("aborting a relayed notice rejects it with the reason and tells the owner to stop", async () => {
    const { captured, sent } = await join(0, 2);
    const remote = clientFor(1, 2);
    const control = new AbortController();
    const outcome = captured.relay?.forward(remote)?.(remote, notice, {
      ackTimeoutMs: 1000,
      signal: control.signal,
    });
    control.abort(new Error("step cancelled"));
    await expect(outcome).rejects.toThrow(/step cancelled/);
    expect(sent.at(-1)).toMatchObject({ type: "aai-start:relay-cancel", target: 1 });
  });

  test("an already-aborted signal rejects without sending anything", async () => {
    const { captured, sent } = await join(0, 2);
    const remote = clientFor(1, 2);
    const control = new AbortController();
    control.abort(new Error("gone"));
    const outcome = captured.relay?.forward(remote)?.(remote, notice, {
      ackTimeoutMs: 1000,
      signal: control.signal,
    });
    await expect(outcome).rejects.toThrow(/gone/);
    expect(sent.filter((m) => m.type === "aai-start:relay")).toEqual([]);
  });

  test("a relayed notice is delivered locally and answered to its origin", async () => {
    const { captured, sent, deliver } = await join(1, 2, "acked");
    const local = clientFor(1, 2);
    deliver({
      type: "aai-start:relay",
      id: 9,
      origin: 0,
      payload: { op: "notify", clientId: local, notice, ackTimeoutMs: 50 },
    });
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        type: "aai-start:relay-result",
        id: 9,
        origin: 0,
        outcome: "acked",
      }),
    );
    expect(captured.delivered).toEqual([local]);
  });

  test("a cancelled relayed notice is aborted and answers nothing", async () => {
    const link = fakeLink();
    let seenSignal: AbortSignal | undefined;
    const runtime: WorkerRuntime = {
      setSessionIdMinter: () => undefined,
      setClientNotifyRelay: () => undefined,
      notifyClientHere: (_id, _notice, { signal }) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    };
    await joinCluster({
      slot: 0,
      slots: 1,
      server: fakeServer(),
      name: "A",
      link: link.link,
      runtime,
    });
    link.deliver({
      type: "aai-start:relay",
      id: 4,
      origin: 1,
      payload: { op: "notify", clientId: "c", notice, ackTimeoutMs: 1000 },
    });
    link.deliver({ type: "aai-start:relay-cancel", id: 4, origin: 1 });
    expect(seenSignal?.aborted).toBe(true);
    // Let the delivery chain (reject → catch → then) settle: microtask hops, no timer.
    for (let hop = 0; hop < 5; hop++) await Promise.resolve();
    expect(link.sent.filter((m) => m.type === "aai-start:relay-result")).toEqual([]);
  });

  test("an upgrade handoff replays the request bytes and hands the socket to the server", async () => {
    const { deliver, server } = await join(0, 1);
    let handed: unknown;
    server.node.on("connection", (socket: unknown) => {
      handed = socket;
    });
    // An unconnected socket: a real object, no network.
    const socket = new Socket();
    const unshift = vi.spyOn(socket, "unshift");
    const resume = vi.spyOn(socket, "resume");
    deliver(
      { type: "aai-start:upgrade", bytes: Buffer.from("GET /websocket HTTP/1.1\r\n\r\n") },
      socket,
    );
    expect(String(unshift.mock.calls[0]?.[0])).toBe("GET /websocket HTTP/1.1\r\n\r\n");
    expect(handed).toBe(socket);
    expect(resume).toHaveBeenCalled();
    socket.destroy();
  });
});

describe("joinCluster liveness", () => {
  test("answers a ping with a pong, proving its event loop turns", async () => {
    const { deliver, sent } = await join(0, 2);
    deliver({ type: "aai-start:ping" });
    expect(sent.at(-1)).toMatchObject({ type: "aai-start:pong", calls: 0 });
    const pong = sent.at(-1);
    if (pong?.type !== "aai-start:pong") throw new Error("no pong");
    expect(pong.elu).toBeGreaterThanOrEqual(0);
    expect(pong.elu).toBeLessThanOrEqual(1);
  });
});

describe("joinCluster call counting and commands", () => {
  async function joinWithCommands() {
    const link = fakeLink();
    const { runtime } = fakeRuntime();
    const drains: number[] = [];
    let stops = 0;
    const joined = await joinCluster({
      slot: 0,
      slots: 1,
      server: fakeServer(),
      name: "A",
      link: link.link,
      runtime,
      onDrain: (ms) => drains.push(ms),
      onStop: () => {
        stops += 1;
      },
    });
    return { ...link, joined, drains, stops: () => stops };
  }

  test("a handed-off call socket counts until it closes; an /inbox socket never does", async () => {
    const run = await joinWithCommands();
    const call = new Socket();
    const inbox = new Socket();
    run.deliver(
      { type: "aai-start:upgrade", bytes: Buffer.from("GET /websocket?client=c HTTP/1.1\r\n\r\n") },
      call,
    );
    run.deliver(
      { type: "aai-start:upgrade", bytes: Buffer.from("GET /inbox?client=c HTTP/1.1\r\n\r\n") },
      inbox,
    );
    expect(run.joined.activeCalls()).toBe(1);
    run.deliver({ type: "aai-start:ping" });
    expect(run.sent.at(-1)).toMatchObject({ type: "aai-start:pong", calls: 1 });
    call.destroy();
    await vi.waitFor(() => expect(run.joined.activeCalls()).toBe(0));
    inbox.destroy();
  });

  test("drain and stop from the primary reach their callbacks", async () => {
    const run = await joinWithCommands();
    run.deliver({ type: "aai-start:drain", timeoutMs: 1234 });
    run.deliver({ type: "aai-start:stop" });
    expect(run.drains).toEqual([1234]);
    expect(run.stops()).toBe(1);
  });
});

describe("requestPath", () => {
  test("reads the path from a request head, without its query", () => {
    expect(requestPath(Buffer.from("GET /websocket?client=a HTTP/1.1\r\n"))).toBe("/websocket");
    expect(requestPath(Buffer.from("GET /phone HTTP/1.1\r\n"))).toBe("/phone");
    expect(requestPath(Buffer.from("garbage"))).toBe("");
  });
});

describe("workflowsNeedDatabase", () => {
  test("names the worker count and the remedy", () => {
    expect(workflowsNeedDatabase(4)).toMatch(/on 4 workers needs DATABASE_URL/);
  });
});
