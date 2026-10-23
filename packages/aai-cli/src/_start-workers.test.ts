// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start --workers` — the count, the `DATABASE_URL` rule, and the
 * supervisor's readiness and respawn policy, driven through a fake cluster so
 * nothing forks.
 */

import { describe, expect, test } from "vitest";
import {
  assertWorkersSupported,
  type ClusterLike,
  parseWorkers,
  resolveWorkers,
  superviseWorkers,
  WORKERS_ENV,
  type WorkerLike,
} from "./_start-workers.ts";

describe("parseWorkers / resolveWorkers", () => {
  test("a positive integer is itself, and `auto` is one per CPU", () => {
    expect(parseWorkers("4", "--workers")).toBe(4);
    expect(parseWorkers(" AUTO ", "--workers", () => 8)).toBe(8);
    expect(parseWorkers("auto", "--workers", () => 0)).toBe(1);
  });

  test.each(["0", "-2", "1.5", "two", ""])("refuses %j, naming the input", (value) => {
    expect(() => parseWorkers(value, "AAI_WORKERS")).toThrow(
      /AAI_WORKERS must be a positive integer or "auto"/,
    );
  });

  test("the flag wins over the env, and neither means one process", () => {
    expect(resolveWorkers("3", { [WORKERS_ENV]: "5" })).toBe(3);
    expect(resolveWorkers(undefined, { [WORKERS_ENV]: "5" })).toBe(5);
    expect(resolveWorkers(undefined, { [WORKERS_ENV]: "  " })).toBe(1);
    expect(resolveWorkers(undefined, {})).toBe(1);
  });
});

describe("assertWorkersSupported", () => {
  test("one worker never needs a database", () => {
    expect(() => assertWorkersSupported(1, undefined)).not.toThrow();
  });

  test("several workers without DATABASE_URL are refused, saying why", () => {
    expect(() => assertWorkersSupported(4, undefined)).toThrow(/--workers 4 needs DATABASE_URL/);
    expect(() => assertWorkersSupported(4, "")).toThrow(/round-robin/);
    expect(() => assertWorkersSupported(4, "postgres://db/x")).not.toThrow();
  });
});

type ExitListener = (worker: WorkerLike, code: number | null, signal: string | null) => void;
type MessageListener = (worker: WorkerLike, message: unknown) => void;

/** A cluster that records forks and lets a test drive each worker's messages and exit. */
function fakeCluster() {
  let nextPid = 100;
  const workers: (WorkerLike & { killed: string[] })[] = [];
  let onExit: ExitListener = () => undefined;
  let onMessage: MessageListener = () => undefined;
  const cluster: ClusterLike = {
    fork() {
      const killed: string[] = [];
      const worker = {
        process: { pid: nextPid++ },
        killed,
        kill: (s = "SIGTERM") => void killed.push(s),
      };
      workers.push(worker);
      return worker;
    },
    on(event: "exit" | "message", listener: ExitListener | MessageListener) {
      if (event === "exit") onExit = listener as ExitListener;
      else onMessage = listener as MessageListener;
    },
  } as ClusterLike;
  const byPid = (pid: number) => {
    const w = workers.find((x) => x.process.pid === pid);
    if (!w) throw new Error(`no worker ${pid}`);
    return w;
  };
  return {
    cluster,
    workers,
    listen: (pid: number, port = 3000) =>
      onMessage(byPid(pid), { type: "aai-start:listening", name: "Agent", port }),
    exit: (pid: number, code: number | null = 1, signal: string | null = null) =>
      onExit(byPid(pid), code, signal),
  };
}

function supervise(count: number) {
  const fake = fakeCluster();
  const logs: string[] = [];
  const supervisor = superviseWorkers({ count, cluster: fake.cluster, log: (m) => logs.push(m) });
  return { ...fake, supervisor, logs };
}

describe("superviseWorkers", () => {
  test("is ready only once EVERY worker reports listening, with the reported name and port", async () => {
    const run = supervise(2);
    let ready: unknown;
    void run.supervisor.ready.then((r) => {
      ready = r;
    });
    run.listen(100, 4321);
    await Promise.resolve();
    expect(ready).toBeUndefined();
    run.listen(101, 4321);
    await expect(run.supervisor.ready).resolves.toEqual({ name: "Agent", port: 4321 });
  });

  test("a worker that dies after listening is replaced", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.exit(100);
    expect(run.workers).toHaveLength(3);
    expect(run.logs[0]).toMatch(/worker 100 exited with code 1; starting a replacement/);
  });

  test("a worker that dies before listening stops every worker, then fails ready", async () => {
    const run = supervise(3);
    run.listen(101);
    run.exit(100);
    expect(run.logs[0]).toMatch(/while starting; stopping the server/);
    expect(run.workers.map((w) => w.killed)).toEqual([[], ["SIGTERM"], ["SIGTERM"]]);
    expect(run.workers).toHaveLength(3); // no respawn
    run.exit(101, 0);
    run.exit(102, 0);
    await expect(run.supervisor.ready).rejects.toThrow(/before it was listening/);
    await expect(run.supervisor.exited).resolves.toBe(1);
  });

  test("stop() passes the signal on, respawns nothing, and exits 0 when all stop cleanly", async () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.supervisor.stop("SIGINT");
    run.supervisor.stop("SIGINT"); // idempotent for the exit code
    expect(run.workers[0]?.killed).toContain("SIGINT");
    run.exit(100, 0);
    run.exit(101, 0);
    expect(run.workers).toHaveLength(2);
    await expect(run.supervisor.exited).resolves.toBe(0);
  });

  test("a worker whose shutdown fails makes the whole stop exit 1", async () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.supervisor.stop();
    run.exit(100, 1);
    run.exit(101, 0);
    await expect(run.supervisor.exited).resolves.toBe(1);
  });
});
