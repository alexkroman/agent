// Copyright 2026 the AAI authors. MIT license.
/**
 * The two halves of `aai start --workers` as functions of their collaborators:
 * the PRIMARY (fork, wait for every slot, bind the router, stop on a signal)
 * and the WORKER (refuse what it cannot serve, build, join). `start.ts` hands
 * them the real process, cluster and port; the unit tier hands them fakes.
 *
 * @module
 */

import type http from "node:http";
import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import { createRouter } from "./_start-router.ts";
import {
  joinCluster,
  type PrimaryLink,
  type WorkerRuntime,
  workflowsNeedDatabase,
} from "./_start-worker.ts";
import { type ClusterLike, superviseWorkers } from "./_start-workers.ts";

/** What the primary needs from the process around it. */
export interface PrimaryDeps {
  cluster: ClusterLike;
  /** Bind the router; resolves with the bound port, rejects when the bind fails. */
  listen(server: http.Server, port: number, host: string | undefined): Promise<number>;
  /** Run `handler` on each SIGINT/SIGTERM. */
  onSignal(handler: (signal: NodeJS.Signals) => void): void;
  /** End the process once every worker has exited after a stop. */
  exit(code: number): void;
  /** One supervisor line (a worker exiting, being replaced). */
  log(message: string): void;
}

/** How the primary places and retires calls. */
export interface PrimaryOptions {
  workers: number;
  port: number;
  host: string | undefined;
  /** How long a drain lets calls finish before the worker is closed anyway. */
  drainTimeoutMs: number;
  /** Calls a worker may hold before NEW ones are refused with 503. */
  maxCallsPerWorker: number;
}

/**
 * Run the primary: fork `workers` slots, bind the router once EVERY slot
 * listens, and own every worker's lifecycle — workers ignore signals, so this
 * is where they are interpreted:
 *
 * - the first SIGINT/SIGTERM DRAINS: new calls are refused (503), everything
 *   else — a reconnect, an `/api` call, a run read — still routes, and each
 *   worker exits once its calls end or `drainTimeoutMs` passes;
 * - a second one STOPS: every worker closes now;
 * - SIGHUP is a ROLLING RESTART: each slot's worker is replaced by a fresh one
 *   that takes the slot's new traffic, while the old one drains its calls.
 *
 * Resolves with the agent's name (as the workers report it) and the bound
 * port; rejects — with every worker stopped — when a worker fails to boot or
 * the port cannot be bound.
 */
export async function runPrimary(
  opts: PrimaryOptions,
  deps: PrimaryDeps,
): Promise<{ name: string; port: number }> {
  const supervisor = superviseWorkers({
    slots: opts.workers,
    cluster: deps.cluster,
    log: deps.log,
  });
  const router = createRouter({
    slots: opts.workers,
    target: supervisor.target,
    // The cap covers every call socket; only the drain lets a reconnect
    // through, so live calls survive a deploy. A client can CLAIM to resume
    // (any well-formed id), which is why that claim never buys past the cap.
    admitCall: (slot, resume) => {
      if (!(supervisor.accepting() || resume)) return "draining";
      return supervisor.calls(slot) >= opts.maxCallsPerWorker ? "full" : "ok";
    },
    reserveCall: supervisor.reserve,
    status: supervisor.status,
  });
  let signals = 0;
  deps.onSignal((signal) => {
    if (signal === "SIGHUP") return supervisor.roll(opts.drainTimeoutMs);
    signals += 1;
    if (signals > 1) return supervisor.stop();
    deps.log(
      `draining: new calls are refused; live calls get up to ${opts.drainTimeoutMs / 1000}s ` +
        "(signal again to stop now)",
    );
    supervisor.drain(opts.drainTimeoutMs);
  });
  const { name } = await supervisor.ready;
  let port: number;
  try {
    port = await deps.listen(router, opts.port, opts.host);
  } catch (error: unknown) {
    supervisor.stop();
    await supervisor.exited;
    throw error;
  }
  void supervisor.exited.then((code) => {
    // The last line of a drain: without it the process just vanishes, and an
    // operator watching a deploy cannot tell a finished drain from a crash.
    deps.log(
      code === 0 ? "every worker has exited; stopping" : "stopping (a worker exited with an error)",
    );
    router.close();
    deps.exit(code);
  });
  return { name, port };
}

/** Bind `server` the way the primary does; the real {@link PrimaryDeps.listen}. */
export function listenServer(
  server: http.Server,
  port: number,
  host: string | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host ?? "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** What a worker needs to build and join. */
export interface WorkerDeps {
  link: PrimaryLink;
  load(): Promise<{ agent: AgentDef; env: Record<string, string> }>;
  build(agent: AgentDef, env: Record<string, string>): Promise<AgentServer>;
  runtime?: WorkerRuntime;
  /** The primary's lifecycle commands — see {@link runPrimary}. */
  onDrain?: (timeoutMs: number) => void;
  onStop?: () => void;
}

/**
 * Serve slot `slot` of `slots`: refuse an agent with workflows and no database
 * (a run must be readable from every worker), build the server, join. On any
 * failure the primary is told WHY before this rejects, so its error names the
 * cause rather than "a worker exited".
 */
export async function runWorker(
  opts: { slot: number; slots: number },
  deps: WorkerDeps,
): Promise<{ server: AgentServer; activeCalls: () => number }> {
  try {
    const { agent, env } = await deps.load();
    if (!env.DATABASE_URL && Object.keys(agent.workflows ?? {}).length > 0) {
      throw new Error(workflowsNeedDatabase(opts.slots));
    }
    const server = await deps.build(agent, env);
    const { activeCalls } = await joinCluster({
      slot: opts.slot,
      slots: opts.slots,
      server,
      name: agent.name,
      link: deps.link,
      ...omitUndefined({ runtime: deps.runtime, onDrain: deps.onDrain, onStop: deps.onStop }),
    });
    return { server, activeCalls };
  } catch (error: unknown) {
    deps.link.send({
      type: "aai-start:fatal",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
