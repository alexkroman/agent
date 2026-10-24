// Copyright 2026 the AAI authors. MIT license.
/**
 * One `aai start --workers` worker joining its primary.
 *
 * The worker serves the ordinary `AgentServer`, reached two ways and never on
 * the public port (the primary owns that — `_start-router.ts`):
 *
 * - a WebSocket upgrade arrives over IPC as the raw socket plus the request
 *   bytes the primary already read; they go back into the socket's buffer and
 *   the socket is handed to this server's HTTP listener as a new connection;
 * - plain HTTP arrives proxied on a private loopback port.
 *
 * It also installs this process's two runtime seams: session ids are minted to
 * hash to this worker's slot (so a resume naming only the id routes here), and
 * an `/inbox` notice for a client another worker owns is relayed through the
 * primary to that worker, which delivers it locally.
 *
 * @module
 */

import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { ClientNotifier } from "@alexkroman1/aai/host-internal";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import {
  notifyClientHere,
  setClientNotifyRelay,
  setSessionIdMinter,
} from "@alexkroman1/aai-runtime/internal";
import { clientKey, mintIdForSlot, slotOf } from "./_start-affinity.ts";
import {
  isProtocolMessage,
  type PrimaryMessage,
  type RelayOutcome,
  type WorkerMessage,
} from "./_start-workers.ts";

/** This worker's line to its primary — a seam, so the unit tier needs no cluster. */
export interface PrimaryLink {
  send(message: WorkerMessage): void;
  onMessage(listener: (message: PrimaryMessage, socket: Socket | undefined) => void): void;
}

/** The slice of `process` a link uses — injected, so a spec need not touch the runner's IPC. */
export interface IpcProcess {
  send?: ((message: WorkerMessage) => unknown) | undefined;
  on(event: "message", listener: (message: unknown, handle: unknown) => void): unknown;
}

/** The real link: this process's IPC channel. */
export function processLink(proc: IpcProcess = process): PrimaryLink {
  return {
    send: (message) => {
      proc.send?.(message);
    },
    onMessage: (listener) => {
      proc.on("message", (message, handle) => {
        if (!isProtocolMessage<PrimaryMessage>(message)) return;
        listener(message, handle instanceof Socket ? handle : undefined);
      });
    },
  };
}

/** The refusal a worker reports when the agent needs state it cannot share. */
export function workflowsNeedDatabase(workers: number): string {
  return (
    `This agent declares workflows, and running it on ${workers} workers needs DATABASE_URL: ` +
    "a run started on one worker must be readable and resumable from every other. " +
    "Set DATABASE_URL (any Postgres), or run with `--workers 1`."
  );
}

/** The runtime seams a worker installs — injected, so a spec can watch them. */
export interface WorkerRuntime {
  setSessionIdMinter: typeof setSessionIdMinter;
  setClientNotifyRelay: typeof setClientNotifyRelay;
  notifyClientHere: typeof notifyClientHere;
}

const realRuntime: WorkerRuntime = { setSessionIdMinter, setClientNotifyRelay, notifyClientHere };

/** Install the relay client: a notice for a client another slot owns goes through the primary. */
function installRelayClient(
  slot: number,
  slots: number,
  link: PrimaryLink,
  runtime: WorkerRuntime,
) {
  let nextId = 0;
  const pending = new Map<number, (outcome: RelayOutcome) => void>();
  runtime.setClientNotifyRelay({
    forward(clientId) {
      const target = slotOf(clientKey(clientId), slots);
      if (target === slot) return;
      const viaPrimary: ClientNotifier = (id, notice, { ackTimeoutMs, signal }) =>
        new Promise<RelayOutcome>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          const relayId = ++nextId;
          // The local inbox rejects with the signal's reason on abort; a relayed
          // notice does the same, and tells the owner to stop waiting too.
          const onAbort = (): void => {
            if (!pending.delete(relayId)) return;
            link.send({ type: "aai-start:relay-cancel", id: relayId, target });
            reject(signal?.reason);
          };
          pending.set(relayId, (outcome) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
          });
          signal?.addEventListener("abort", onAbort, { once: true });
          link.send({
            type: "aai-start:relay",
            id: relayId,
            target,
            payload: { op: "notify", clientId: id, notice, ackTimeoutMs },
          });
        });
      return viaPrimary;
    },
  });
  return (id: number, outcome: RelayOutcome): void => {
    const settle = pending.get(id);
    pending.delete(id);
    settle?.(outcome);
  };
}

/**
 * Serve `server` as worker `slot` of `slots`: install the seams, bind the
 * private port, and report listening. Resolves once reported.
 */
export async function joinCluster(opts: {
  slot: number;
  slots: number;
  server: AgentServer;
  name: string;
  link: PrimaryLink;
  runtime?: WorkerRuntime | undefined;
  /**
   * The primary asked this worker to end: finish its calls within `graceMs`
   * (a drain's timeout; 0 for a stop) and exit.
   */
  close?: ((graceMs: number) => void) | undefined;
}): Promise<{ activeCalls: () => number }> {
  const { slot, slots, server, link, runtime = realRuntime } = opts;
  /** Live call sockets: incremented at handoff, decremented when the socket closes. */
  let calls = 0;
  /** Call sockets ever handed over — lets the primary count the ones still in transit. */
  let received = 0;
  let eluMark = performance.eventLoopUtilization();
  runtime.setSessionIdMinter(() => mintIdForSlot(slot, slots));
  const settleRelay = installRelayClient(slot, slots, link, runtime);
  /** Relayed notices this worker is delivering, keyed `origin:id`, so a cancel can abort one. */
  const delivering = new Map<string, AbortController>();

  link.onMessage((message, socket) => {
    switch (message.type) {
      case "aai-start:upgrade": {
        if (!socket) return;
        // The primary read the request head to route it; put those bytes back
        // where this server's parser will read them first.
        if (message.call) {
          calls += 1;
          received += 1;
          socket.once("close", () => {
            calls -= 1;
          });
        }
        socket.unshift(Buffer.from(message.bytes));
        server.node.emit("connection", socket);
        socket.resume();
        return;
      }
      case "aai-start:relay": {
        const key = `${message.origin}:${message.id}`;
        const control = new AbortController();
        delivering.set(key, control);
        const { clientId, notice, ackTimeoutMs } = message.payload;
        // Fire-and-forget by design: the result travels back as a message, and
        // the chain cannot reject (the catch turns any failure into an outcome).
        void runtime
          .notifyClientHere(clientId, notice, { ackTimeoutMs, signal: control.signal })
          .catch((): RelayOutcome => "disconnected")
          .then((outcome) => {
            // Deleted by a cancel: the origin has stopped waiting, so say nothing.
            if (!delivering.delete(key)) return;
            link.send({
              type: "aai-start:relay-result",
              id: message.id,
              origin: message.origin,
              outcome,
            });
          });
        return;
      }
      case "aai-start:relay-cancel": {
        const key = `${message.origin}:${message.id}`;
        const control = delivering.get(key);
        delivering.delete(key);
        control?.abort(new Error("relayed notice cancelled by its sender"));
        return;
      }
      case "aai-start:relay-result":
        settleRelay(message.id, message.outcome);
        return;
      case "aai-start:ping": {
        // Answered from the event loop, so a reply proves the loop is turning;
        // it carries this worker's load since the last one.
        const elu = performance.eventLoopUtilization(eluMark);
        eluMark = performance.eventLoopUtilization();
        link.send({
          type: "aai-start:pong",
          calls,
          received,
          elu: Math.round(elu.utilization * 1000) / 1000,
        });
        return;
      }
      case "aai-start:drain":
        opts.close?.(message.timeoutMs);
        return;
      case "aai-start:stop":
        opts.close?.(0);
        return;
      default:
        return;
    }
  });

  // Loopback and ephemeral: only the primary's proxy dials it.
  await server.listen(0, "127.0.0.1");
  if (server.port === undefined) throw new Error("worker could not bind its private port");
  link.send({ type: "aai-start:listening", name: opts.name, port: server.port });
  return { activeCalls: () => calls };
}
