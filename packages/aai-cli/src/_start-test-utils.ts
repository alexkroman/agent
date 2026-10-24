// Copyright 2026 the AAI authors. MIT license.
/**
 * The fakes the `aai start` specs share: a server that binds nothing, a
 * cluster that forks nothing, and a link to a primary with no IPC behind it.
 */

import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import { clientKey, slotOf } from "./_start-affinity.ts";
import type { PrimaryLink } from "./_start-worker.ts";
import type { ClusterLike, PrimaryMessage, WorkerLike, WorkerMessage } from "./_start-workers.ts";

/** An `AgentServer` whose `listen` records `port` and binds nothing. */
export function fakeServer(port = 4567): AgentServer {
  let bound: number | undefined;
  const server: Partial<AgentServer> = {
    node: new EventEmitter() as AgentServer["node"],
    get port() {
      return bound;
    },
    async listen() {
      bound = port;
    },
    async close() {
      bound = undefined;
    },
  };
  return server as AgentServer;
}

/** A link to a primary that records what the worker sends and lets a spec speak. */
export function fakeLink() {
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

/** A forked fake: the env it was given, the signals it got, the messages sent to it. */
export type FakeWorker = WorkerLike & {
  pid: number;
  env: Record<string, string>;
  killed: string[];
  inbox: PrimaryMessage[];
};

/**
 * A cluster a spec drives by hand: pids count up from `firstPid`; with `eager`
 * every worker reports listening (as `Agent`, on port 4000 + pid) as soon as
 * it is forked.
 */
export function fakeCluster(opts: { firstPid?: number; eager?: boolean } = {}) {
  let nextPid = opts.firstPid ?? 100;
  const workers: FakeWorker[] = [];
  let onExit: Parameters<ClusterLike["onExit"]>[0] = () => undefined;
  let onMessage: Parameters<ClusterLike["onMessage"]>[0] = () => undefined;
  const byPid = (pid: number): FakeWorker => {
    const worker = workers.find((w) => w.pid === pid);
    if (!worker) throw new Error(`no worker ${pid}`);
    return worker;
  };
  const listen = (pid: number, port = 4000 + pid) =>
    onMessage(byPid(pid), { type: "aai-start:listening", name: "Agent", port });
  const cluster: ClusterLike = {
    fork(env) {
      const worker: FakeWorker = {
        pid: nextPid++,
        env,
        killed: [],
        inbox: [],
        kill(signal = "SIGTERM") {
          worker.killed.push(signal);
        },
        send(message) {
          worker.inbox.push(message);
          return true;
        },
      };
      workers.push(worker);
      if (opts.eager) queueMicrotask(() => listen(worker.pid));
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
    say: (pid: number, message: unknown) => onMessage(byPid(pid), message),
    listen,
    listenAll: () => {
      for (const worker of workers) listen(worker.pid);
    },
    /** `received`: call sockets the worker has been handed so far (see `onPong`). */
    pong: (pid: number, calls = 0, elu = 0, received = 0) =>
      onMessage(byPid(pid), { type: "aai-start:pong", calls, elu, received }),
    exit: (pid: number, code: number | null = 1, signal: string | null = null) =>
      onExit(byPid(pid), code, signal),
  };
}

/** A client id that routes to `slot` of `slots`. */
export function clientFor(slot: number, slots: number): string {
  for (let i = 0; ; i++) if (slotOf(clientKey(`c${i}`), slots) === slot) return `c${i}`;
}
