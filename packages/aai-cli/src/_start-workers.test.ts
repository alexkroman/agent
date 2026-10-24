// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start --workers` — the count, and the supervisor's readiness, respawn
 * and relay policy, driven through a fake cluster so nothing forks.
 */

import { describe, expect, test } from "vitest";
import {
  type ClusterLike,
  LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  type PrimaryMessage,
  parseWorkers,
  resolveWorkers,
  SLOT_ENV,
  SLOTS_ENV,
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

type FakeWorker = WorkerLike & {
  env: Record<string, string>;
  killed: string[];
  inbox: PrimaryMessage[];
};

/** A cluster that records forks and lets a test drive each worker's messages and exit. */
function fakeCluster() {
  let nextPid = 100;
  const workers: FakeWorker[] = [];
  let onExit: Parameters<ClusterLike["onExit"]>[0] = () => undefined;
  let onMessage: Parameters<ClusterLike["onMessage"]>[0] = () => undefined;
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
        },
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
  const byPid = (pid: number): FakeWorker => {
    const worker = workers.find((w) => w.pid === pid);
    if (!worker) throw new Error(`no worker ${pid}`);
    return worker;
  };
  return {
    cluster,
    workers,
    say: (pid: number, message: unknown) => onMessage(byPid(pid), message),
    listen: (pid: number, port = 4000 + pid) =>
      onMessage(byPid(pid), { type: "aai-start:listening", name: "Agent", port }),
    exit: (pid: number, code: number | null = 1, signal: string | null = null) =>
      onExit(byPid(pid), code, signal),
  };
}

function supervise(slots: number) {
  const fake = fakeCluster();
  const logs: string[] = [];
  const supervisor = superviseWorkers({ slots, cluster: fake.cluster, log: (m) => logs.push(m) });
  return { ...fake, supervisor, logs };
}

describe("superviseWorkers", () => {
  test("forks one worker per slot, telling each its slot and the slot count", () => {
    const run = supervise(3);
    expect(run.workers.map((w) => w.env)).toEqual([
      { [SLOT_ENV]: "0", [SLOTS_ENV]: "3" },
      { [SLOT_ENV]: "1", [SLOTS_ENV]: "3" },
      { [SLOT_ENV]: "2", [SLOTS_ENV]: "3" },
    ]);
  });

  test("is ready only once EVERY slot listens; target() names each slot's private port", async () => {
    const run = supervise(2);
    let ready: unknown;
    void run.supervisor.ready.then((value) => {
      ready = value;
    });
    run.listen(100, 5000);
    await Promise.resolve();
    expect(ready).toBeUndefined();
    expect(run.supervisor.target(0)?.port).toBe(5000);
    expect(run.supervisor.target(1)).toBeUndefined();
    run.listen(101, 5001);
    await expect(run.supervisor.ready).resolves.toEqual({ name: "Agent" });
  });

  test("a worker that dies after listening is replaced IN ITS SLOT, unroutable meanwhile", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.exit(100);
    expect(run.supervisor.target(0)).toBeUndefined();
    expect(run.workers).toHaveLength(3);
    expect(run.workers[2]?.env[SLOT_ENV]).toBe("0");
    expect(run.logs[0]).toMatch(/worker 100 \(slot 0\) exited with code 1; starting a replacement/);
  });

  test("a worker that dies before listening stops every worker and fails ready with its reason", async () => {
    const run = supervise(3);
    run.listen(101);
    run.say(100, { type: "aai-start:fatal", message: "This agent declares workflows" });
    run.exit(100);
    expect(run.logs[0]).toMatch(/while starting; stopping the server/);
    expect(run.workers.map((w) => w.killed)).toEqual([[], ["SIGTERM"], ["SIGTERM"]]);
    run.exit(101, 0);
    run.exit(102, 0);
    await expect(run.supervisor.ready).rejects.toThrow(/declares workflows/);
    await expect(run.supervisor.exited).resolves.toBe(1);
    expect(run.workers).toHaveLength(3);
  });

  test("stop() passes the signal on, respawns nothing, and exits 0 when all stop cleanly", async () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.supervisor.stop("SIGINT");
    expect(run.workers[0]?.killed).toEqual(["SIGINT"]);
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

describe("superviseWorkers relays an inbox notice between workers", () => {
  const payload = {
    op: "notify" as const,
    clientId: "phone-1",
    notice: { id: "n1", event: "reminder" },
    ackTimeoutMs: 1000,
  };

  test("forwards to the target slot, then carries the result back to the origin", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.say(100, { type: "aai-start:relay", id: 7, target: 1, payload });
    expect(run.workers[1]?.inbox).toEqual([{ type: "aai-start:relay", id: 7, origin: 0, payload }]);
    run.say(101, { type: "aai-start:relay-result", id: 7, origin: 0, outcome: "acked" });
    expect(run.workers[0]?.inbox).toEqual([
      { type: "aai-start:relay-result", id: 7, outcome: "acked" },
    ]);
  });

  test("a cancel is forwarded to the target", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.say(100, { type: "aai-start:relay-cancel", id: 7, target: 1 });
    expect(run.workers[1]?.inbox).toEqual([{ type: "aai-start:relay-cancel", id: 7, origin: 0 }]);
  });

  test("a target that is not listening answers offline at once", () => {
    const run = supervise(2);
    run.listen(100);
    run.say(100, { type: "aai-start:relay", id: 1, target: 1, payload });
    expect(run.workers[0]?.inbox).toEqual([
      { type: "aai-start:relay-result", id: 1, outcome: "offline" },
    ]);
  });

  test("a target that dies with a notice in flight answers it disconnected", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.say(100, { type: "aai-start:relay", id: 3, target: 1, payload });
    run.exit(101);
    expect(run.workers[0]?.inbox).toEqual([
      { type: "aai-start:relay-result", id: 3, outcome: "disconnected" },
    ]);
  });

  test("messages outside the protocol are ignored", () => {
    const run = supervise(1);
    run.say(100, "hello");
    run.say(100, { type: "something-else" });
    expect(run.workers[0]?.inbox).toEqual([]);
  });
});

describe("superviseWorkers liveness", () => {
  function supervisedWithClock(slots: number) {
    const fake = fakeCluster();
    let clock = 0;
    let tick: () => void = () => undefined;
    let stopped = false;
    const intervals: number[] = [];
    const logs: string[] = [];
    const supervisor = superviseWorkers({
      slots,
      cluster: fake.cluster,
      log: (m) => logs.push(m),
      now: () => clock,
      every: (ms, fn) => {
        intervals.push(ms);
        tick = fn;
        return () => {
          stopped = true;
        };
      },
    });
    return {
      ...fake,
      supervisor,
      logs,
      advance: (ms: number) => {
        clock += ms;
        tick();
      },
      stopped: () => stopped,
      intervals,
    };
  }

  test("pings only listening workers, every PING_INTERVAL_MS", () => {
    const run = supervisedWithClock(2);
    expect(run.intervals).toEqual([PING_INTERVAL_MS]);
    run.listen(100);
    run.advance(PING_INTERVAL_MS);
    expect(run.workers[0]?.inbox).toEqual([{ type: "aai-start:ping" }]);
    expect(run.workers[1]?.inbox).toEqual([]);
  });

  test("a worker that keeps answering is never killed", () => {
    const run = supervisedWithClock(1);
    run.listen(100);
    for (let t = 0; t < LIVENESS_TIMEOUT_MS * 2; t += PING_INTERVAL_MS) {
      run.advance(PING_INTERVAL_MS);
      run.say(100, { type: "aai-start:pong" });
    }
    expect(run.workers[0]?.killed).toEqual([]);
  });

  test("a worker silent for the liveness timeout is killed and respawned into its slot", () => {
    const run = supervisedWithClock(2);
    run.listen(100);
    run.listen(101);
    run.advance(LIVENESS_TIMEOUT_MS - 1);
    run.say(101, { type: "aai-start:pong" });
    expect(run.workers[0]?.killed).toEqual([]);
    run.advance(1);
    expect(run.workers[0]?.killed).toEqual(["SIGKILL"]);
    expect(run.workers[1]?.killed).toEqual([]);
    expect(run.logs[0]).toMatch(/worker 100 has not answered for 60s; restarting it/);
    run.exit(100, null, "SIGKILL");
    expect(run.workers[2]?.env[SLOT_ENV]).toBe("0");
  });

  test("stopping stops the pinging", () => {
    const run = supervisedWithClock(1);
    run.supervisor.stop();
    expect(run.stopped()).toBe(true);
  });
});
