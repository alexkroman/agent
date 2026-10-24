// Copyright 2026 the AAI authors. MIT license.
/**
 * The primary and worker halves of `aai start --workers` driven through fakes:
 * a cluster that forks nothing, a `listen` that binds nothing, a link with no
 * IPC behind it.
 */

import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { agent, workflow } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import { describe, expect, type Mock, test, vi } from "vitest";
import { z } from "zod";
import { type PrimaryDeps, runPrimary, runWorker } from "./_start-cluster.ts";
import type { PrimaryLink, WorkerRuntime } from "./_start-worker.ts";
import type { ClusterLike, WorkerLike, WorkerMessage } from "./_start-workers.ts";

function fakeCluster() {
  let nextPid = 1;
  const workers: (WorkerLike & { killed: string[]; sent: unknown[] })[] = [];
  let onExit: Parameters<ClusterLike["onExit"]>[0] = () => undefined;
  let onMessage: Parameters<ClusterLike["onMessage"]>[0] = () => undefined;
  const cluster: ClusterLike = {
    fork() {
      const killed: string[] = [];
      const sent: unknown[] = [];
      const worker = {
        pid: nextPid++,
        killed,
        sent,
        kill: (signal: NodeJS.Signals = "SIGTERM") => void killed.push(signal),
        send: (message: unknown) => void sent.push(message),
      };
      workers.push(worker);
      return worker;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    onMessage: (listener) => {
      onMessage = listener;
    },
  };
  return {
    cluster,
    workers,
    listenAll: () => {
      for (const w of workers)
        onMessage(w, { type: "aai-start:listening", name: "Agent", port: 9000 + (w.pid ?? 0) });
    },
    exit: (w: WorkerLike, code: number | null) => onExit(w, code, null),
  };
}

function primaryDeps(
  fake: ReturnType<typeof fakeCluster>,
  listen: Mock<PrimaryDeps["listen"]> = vi.fn(async () => 4321),
) {
  let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
  const exits: number[] = [];
  return {
    deps: {
      cluster: fake.cluster,
      listen,
      onSignal: (handler: (signal: NodeJS.Signals) => void) => {
        signalHandler = handler;
      },
      exit: (code: number) => exits.push(code),
      log: () => undefined,
    },
    signal: (s: NodeJS.Signals) => signalHandler?.(s),
    exits,
    listen,
  };
}

const primaryOpts = {
  workers: 2,
  port: 3000,
  host: undefined,
  drainTimeoutMs: 30_000,
  maxCallsPerWorker: 100,
};

describe("runPrimary", () => {
  test("binds only after every slot listens, and answers the workers' name and the bound port", async () => {
    const fake = fakeCluster();
    const p = primaryDeps(fake);
    const running = runPrimary(primaryOpts, p.deps);
    await Promise.resolve();
    expect(p.listen).not.toHaveBeenCalled();
    fake.listenAll();
    await expect(running).resolves.toEqual({ name: "Agent", port: 4321 });
    expect(p.listen).toHaveBeenCalledWith(expect.anything(), 3000, undefined);
  });

  test("a first signal drains every worker; the process exits with their verdict", async () => {
    const fake = fakeCluster();
    const p = primaryDeps(fake);
    const running = runPrimary(primaryOpts, p.deps);
    fake.listenAll();
    await running;
    p.signal("SIGTERM");
    expect(fake.workers.map((w) => w.sent.at(-1))).toEqual([
      { type: "aai-start:drain", timeoutMs: 30_000 },
      { type: "aai-start:drain", timeoutMs: 30_000 },
    ]);
    for (const w of fake.workers) fake.exit(w, 0);
    await vi.waitFor(() => expect(p.exits).toEqual([0]));
  });

  test("a second signal stops at once", async () => {
    const fake = fakeCluster();
    const p = primaryDeps(fake);
    const running = runPrimary(primaryOpts, p.deps);
    fake.listenAll();
    await running;
    p.signal("SIGINT");
    p.signal("SIGINT");
    expect(fake.workers[0]?.sent.at(-1)).toEqual({ type: "aai-start:stop" });
  });

  test("SIGHUP starts a rolling restart: a replacement is forked for slot 0", async () => {
    const fake = fakeCluster();
    const p = primaryDeps(fake);
    const running = runPrimary(primaryOpts, p.deps);
    fake.listenAll();
    await running;
    p.signal("SIGHUP");
    expect(fake.workers).toHaveLength(3);
  });

  test("a port that cannot be bound stops every worker and rejects", async () => {
    const fake = fakeCluster();
    const p = primaryDeps(
      fake,
      vi.fn(async () => Promise.reject(new Error("EADDRINUSE"))),
    );
    const running = runPrimary(primaryOpts, p.deps);
    fake.listenAll();
    await vi.waitFor(() =>
      expect(fake.workers[0]?.sent.at(-1)).toEqual({ type: "aai-start:stop" }),
    );
    for (const w of fake.workers) fake.exit(w, 0);
    await expect(running).rejects.toThrow(/EADDRINUSE/);
  });

  test("a worker that fails to boot rejects without ever binding", async () => {
    const fake = fakeCluster();
    const p = primaryDeps(fake);
    const running = runPrimary(primaryOpts, p.deps);
    const [first, second] = fake.workers;
    if (!(first && second)) throw new Error("expected two workers");
    fake.exit(first, 1);
    fake.exit(second, 0);
    await expect(running).rejects.toThrow(/before it was listening/);
    expect(p.listen).not.toHaveBeenCalled();
  });
});

function fakeLink() {
  const sent: WorkerMessage[] = [];
  const link: PrimaryLink = { send: (m) => sent.push(m), onMessage: () => undefined };
  return { link, sent };
}

const runtime: WorkerRuntime = {
  setSessionIdMinter: () => undefined,
  setClientNotifyRelay: () => undefined,
  notifyClientHere: async () => "offline",
};

function fakeServer(): AgentServer {
  let bound: number | undefined;
  const server: Partial<AgentServer> = {
    node: new EventEmitter() as AgentServer["node"],
    get port() {
      return bound;
    },
    async listen() {
      bound = 5555;
    },
  };
  return server as AgentServer;
}

const voiceAgent = agent({ name: "Voice" });
const workflowAgent = agent({
  name: "Flows",
  workflows: { ping: workflow({ input: z.object({}), run: async () => ({}) }) },
});

describe("runPrimary admission policy", () => {
  /** Drive one upgrade through the primary's router and report whether it was handed off. */
  async function primaryWith(maxCallsPerWorker: number) {
    const fake = fakeCluster();
    let server: import("node:http").Server | undefined;
    const p = primaryDeps(
      fake,
      vi.fn(async (s: import("node:http").Server) => {
        server = s;
        return 4321;
      }),
    );
    const running = runPrimary({ ...primaryOpts, workers: 1, maxCallsPerWorker }, p.deps);
    fake.listenAll();
    await running;
    const upgrade = (url: string) => {
      const before = fake.workers[0]?.sent.length ?? 0;
      const req = new IncomingMessage(new Socket());
      req.method = "GET";
      req.url = url;
      req.httpVersion = "1.1";
      req.headers = { host: "h" };
      req.rawHeaders = ["host", "h"];
      const socket = new Socket();
      vi.spyOn(socket, "end").mockImplementation(() => socket);
      server?.emit("upgrade", req, socket, Buffer.alloc(0));
      socket.destroy();
      return (fake.workers[0]?.sent.length ?? 0) > before;
    };
    return { upgrade, signal: p.signal };
  }

  test("a made-up ?sessionId= does not get a call past the per-worker cap", async () => {
    const run = await primaryWith(1);
    expect(run.upgrade("/websocket?client=a")).toBe(true);
    expect(run.upgrade("/websocket?client=b")).toBe(false);
    expect(run.upgrade(`/websocket?client=b&sessionId=${crypto.randomUUID()}`)).toBe(false);
  });

  test("while draining, a new call is refused but a reconnect still routes", async () => {
    const run = await primaryWith(100);
    run.signal("SIGTERM");
    expect(run.upgrade("/websocket?client=a")).toBe(false);
    expect(run.upgrade(`/websocket?client=a&sessionId=${crypto.randomUUID()}`)).toBe(true);
  });
});

describe("runWorker", () => {
  test("builds, joins and reports listening", async () => {
    const { link, sent } = fakeLink();
    const server = fakeServer();
    const built = await runWorker(
      { slot: 0, slots: 2 },
      {
        link,
        runtime,
        load: async () => ({ agent: voiceAgent, env: {} }),
        build: async () => server,
      },
    );
    expect(built.server).toBe(server);
    expect(built.activeCalls()).toBe(0);
    expect(sent).toEqual([{ type: "aai-start:listening", name: "Voice", port: 5555 }]);
  });

  test("refuses workflows without a database, telling the primary why", async () => {
    const { link, sent } = fakeLink();
    const build = vi.fn(async () => fakeServer());
    await expect(
      runWorker(
        { slot: 0, slots: 3 },
        { link, runtime, load: async () => ({ agent: workflowAgent, env: {} }), build },
      ),
    ).rejects.toThrow(/on 3 workers needs DATABASE_URL/);
    expect(build).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "aai-start:fatal",
      message: expect.stringMatching(/DATABASE_URL/),
    });
  });

  test("workflows WITH a database are served", async () => {
    const { link, sent } = fakeLink();
    await runWorker(
      { slot: 1, slots: 2 },
      {
        link,
        runtime,
        load: async () => ({ agent: workflowAgent, env: { DATABASE_URL: "postgres://x" } }),
        build: async () => fakeServer(),
      },
    );
    expect(sent[0]?.type).toBe("aai-start:listening");
  });

  test("a build failure reaches the primary as the fatal reason", async () => {
    const { link, sent } = fakeLink();
    await expect(
      runWorker(
        { slot: 0, slots: 2 },
        {
          link,
          runtime,
          load: async () => ({ agent: voiceAgent, env: {} }),
          build: async () => Promise.reject(new Error("bad bundle")),
        },
      ),
    ).rejects.toThrow(/bad bundle/);
    expect(sent).toEqual([{ type: "aai-start:fatal", message: "bad bundle" }]);
  });
});
