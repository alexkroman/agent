// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start --workers` — the option parsing, and the supervisor's readiness,
 * respawn, drain, stop, rolling restart, load, liveness and relay policy,
 * driven through a fake cluster and fake timers so nothing forks or waits.
 */

import { describe, expect, test } from "vitest";
import { type FakeWorker, fakeCluster } from "./_start-test-utils.ts";
import {
  LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseWorkers,
  resolvePositiveInt,
  resolveWorkers,
  SLOT_ENV,
  SLOTS_ENV,
  STOP_GRACE_MS,
  superviseWorkers,
  WORKERS_ENV,
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

describe("resolvePositiveInt", () => {
  test("flag, then env, then the fallback", () => {
    expect(resolvePositiveInt("30", "--x", "X", 300, { X: "60" })).toBe(30);
    expect(resolvePositiveInt(undefined, "--x", "X", 300, { X: "60" })).toBe(60);
    expect(resolvePositiveInt(undefined, "--x", "X", 300, {})).toBe(300);
  });

  test("names the unit when the value has one", () => {
    expect(() => resolvePositiveInt("5m", "--drain-timeout", "X", 1, {}, "seconds")).toThrow(
      '--drain-timeout must be a positive whole number of seconds (got "5m")',
    );
  });

  test("refuses a bad value, naming where it came from", () => {
    expect(() => resolvePositiveInt("0", "--x", "X", 1, {})).toThrow(
      /--x must be a positive integer/,
    );
    expect(() => resolvePositiveInt(undefined, "--x", "X", 1, { X: "lots" })).toThrow(
      /X must be a positive integer/,
    );
  });
});

/** A supervisor over a fake cluster, with a clock and timers a test drives by hand. */
function supervise(slots: number, maxCallsPerWorker?: number) {
  let clock = 0;
  const logs: string[] = [];
  const timers: { at: number; fire: () => void }[] = [];
  let tick: () => void = () => undefined;
  let pingingStopped = false;
  const fake = fakeCluster();
  const supervisor = superviseWorkers({
    slots,
    cluster: fake.cluster,
    log: (m) => logs.push(m),
    maxCallsPerWorker,
    timers: {
      now: () => clock,
      every: (_ms, fn) => {
        tick = fn;
        return () => {
          pingingStopped = true;
        };
      },
      after: (ms, fire) => {
        timers.push({ at: clock + ms, fire });
      },
    },
  });
  return {
    ...fake,
    supervisor,
    logs,
    /** Move the clock, firing due timers, and run one liveness tick. */
    advance(ms: number) {
      clock += ms;
      for (const timer of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fire();
      }
      tick();
    },
    pingingStopped: () => pingingStopped,
  };
}

const lastMessage = (worker: FakeWorker | undefined) => worker?.inbox.at(-1);

describe("superviseWorkers — boot and respawn", () => {
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
    expect(run.logs[0]).toBe("worker 0 (pid 100) exited with code 1; starting a replacement");
  });

  test("a crash says how many live calls the worker held", () => {
    const run = supervise(1);
    run.listen(100);
    run.pong(100, 5);
    run.exit(100, null, "SIGKILL");
    expect(run.logs).toEqual([
      "worker 0 (pid 100) exited with signal SIGKILL; starting a replacement (it held 5 live calls)",
    ]);
  });

  test("a worker that dies before listening stops every worker and fails ready with its reason", async () => {
    const run = supervise(3);
    run.listen(101);
    run.say(100, { type: "aai-start:fatal", message: "This agent declares workflows" });
    run.exit(100);
    expect(run.logs[0]).toMatch(/while starting; stopping the server/);
    expect(lastMessage(run.workers[1])).toEqual({ type: "aai-start:stop" });
    // Still starting, so a stop message would be dropped: it is killed outright.
    expect(run.workers[2]?.killed).toEqual(["SIGKILL"]);
    run.exit(101, 0);
    run.exit(102, null, "SIGKILL");
    await expect(run.supervisor.ready).rejects.toThrow(/declares workflows/);
    await expect(run.supervisor.exited).resolves.toBe(1);
    expect(run.workers).toHaveLength(3);
  });
});

describe("superviseWorkers — drain and stop", () => {
  test("stopped before every slot listened, ready rejects rather than hanging", async () => {
    const run = supervise(2);
    run.listen(100);
    run.supervisor.drain(1000);
    run.exit(100, 0);
    run.exit(101, 0);
    await expect(run.supervisor.ready).rejects.toThrow(/stopped before every worker was listening/);
  });

  test("a drain during boot SIGKILLs a still-starting worker at once, and that is not a failure", async () => {
    // A worker that has not reported listening has no IPC listener yet, so the
    // drain message would be dropped and it would sit out the whole timeout.
    const run = supervise(2);
    run.listen(100);
    run.supervisor.drain(300_000);
    expect(lastMessage(run.workers[0])).toEqual({ type: "aai-start:drain", timeoutMs: 300_000 });
    expect(run.workers[0]?.killed).toEqual([]);
    expect(run.workers[1]?.inbox).toEqual([]);
    expect(run.workers[1]?.killed).toEqual(["SIGKILL"]);
    run.exit(101, null, "SIGKILL");
    run.exit(100, 0);
    await expect(run.supervisor.exited).resolves.toBe(0);
  });

  test("a drain mid-roll SIGKILLs the starting replacement; the old worker drains", async () => {
    const run = supervise(1);
    run.listen(100);
    run.supervisor.roll(1000);
    run.supervisor.drain(30_000);
    expect(run.workers[1]?.killed).toEqual(["SIGKILL"]);
    expect(lastMessage(run.workers[0])).toEqual({ type: "aai-start:drain", timeoutMs: 30_000 });
    run.exit(101, null, "SIGKILL");
    run.exit(100, 0);
    await expect(run.supervisor.exited).resolves.toBe(0);
  });

  test("a drain tells every worker, stops placing calls, and respawns nothing", async () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    expect(run.supervisor.accepting()).toBe(true);
    run.supervisor.drain(30_000);
    expect(run.supervisor.accepting()).toBe(false);
    expect(lastMessage(run.workers[0])).toEqual({ type: "aai-start:drain", timeoutMs: 30_000 });
    run.exit(100, 0);
    expect(run.workers).toHaveLength(2);
    run.exit(101, 0);
    await expect(run.supervisor.exited).resolves.toBe(0);
    expect(run.pingingStopped()).toBe(true);
  });

  test("a worker still alive past the drain timeout plus grace is SIGKILLed", () => {
    const run = supervise(1);
    run.listen(100);
    run.supervisor.drain(30_000);
    // Still answering pings while it drains — this is the drain deadline, not liveness.
    for (let t = 0; t < 30_000 + STOP_GRACE_MS - PING_INTERVAL_MS; t += PING_INTERVAL_MS) {
      run.advance(PING_INTERVAL_MS);
      run.pong(100);
    }
    expect(run.workers[0]?.killed).toEqual([]);
    run.advance(PING_INTERVAL_MS);
    expect(run.workers[0]?.killed).toEqual(["SIGKILL"]);
  });

  test("stop() asks every worker to close now, SIGKILLs after the grace, and is idempotent", async () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.supervisor.stop();
    run.supervisor.stop();
    expect(run.workers[0]?.inbox.filter((m) => m.type === "aai-start:stop")).toHaveLength(1);
    run.advance(STOP_GRACE_MS);
    expect(run.workers.map((w) => w.killed)).toEqual([["SIGKILL"], ["SIGKILL"]]);
    run.exit(100, null, "SIGKILL");
    run.exit(101, null, "SIGKILL");
    // The SIGKILL a forced stop sends is the plan, not a failure.
    await expect(run.supervisor.exited).resolves.toBe(0);
  });

  test("a stop during a drain still forces; a second drain is ignored", () => {
    const run = supervise(1);
    run.listen(100);
    run.supervisor.drain(60_000);
    run.supervisor.drain(1);
    run.supervisor.stop();
    expect(run.workers[0]?.inbox.filter((m) => m.type === "aai-start:drain")).toHaveLength(1);
    expect(lastMessage(run.workers[0])).toEqual({ type: "aai-start:stop" });
  });

  test("a worker whose shutdown fails makes the whole stop exit 1", async () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.supervisor.drain(1000);
    run.exit(100, 1);
    run.exit(101, 0);
    await expect(run.supervisor.exited).resolves.toBe(1);
  });
});

describe("superviseWorkers — rolling restart", () => {
  test("replaces one slot at a time: new traffic moves on listen, the old worker drains", () => {
    const run = supervise(2);
    run.listen(100, 5000);
    run.listen(101, 5001);
    run.supervisor.roll(45_000);
    expect(run.workers).toHaveLength(3);
    expect(run.workers[2]?.env[SLOT_ENV]).toBe("0");
    // Until the replacement listens, slot 0 is still the old worker's.
    expect(run.supervisor.target(0)?.port).toBe(5000);
    run.listen(102, 5002);
    expect(run.supervisor.target(0)?.port).toBe(5002);
    expect(lastMessage(run.workers[0])).toEqual({ type: "aai-start:drain", timeoutMs: 45_000 });
    // Slot 1 is next, only after slot 0 is done.
    expect(run.workers[3]?.env[SLOT_ENV]).toBe("1");
    run.listen(103, 5003);
    expect(run.supervisor.target(1)?.port).toBe(5003);
    expect(run.logs.some((l) => l.startsWith("rolling restart complete"))).toBe(true);
    // The drained workers leave without being replaced again.
    run.exit(100, 0);
    run.exit(101, 0);
    expect(run.workers).toHaveLength(4);
    expect(run.supervisor.status().map((s) => s.state)).toEqual(["serving", "serving"]);
  });

  test("a replacement that fails to start stops the roll and leaves the old worker serving", () => {
    const run = supervise(2);
    run.listen(100, 5000);
    run.listen(101, 5001);
    run.supervisor.roll(45_000);
    run.say(102, { type: "aai-start:fatal", message: "chaos: broken build" });
    run.exit(102, 1);
    expect(run.supervisor.target(0)?.port).toBe(5000);
    expect(run.logs.at(-1)).toBe(
      "rolling restart stopped: the replacement for slot 0 exited with code 1 while starting: chaos: broken build",
    );
    expect(run.workers).toHaveLength(3);
    expect(run.supervisor.accepting()).toBe(true);
  });

  test("a second roll while one runs is ignored; none starts once draining", () => {
    const run = supervise(1);
    run.listen(100);
    run.supervisor.roll(1000);
    run.supervisor.roll(1000);
    expect(run.workers).toHaveLength(2);
    run.supervisor.drain(1000);
    run.supervisor.roll(1000);
    expect(run.workers).toHaveLength(2);
    // Said, not swallowed: an operator who sent SIGHUP is waiting for a roll.
    expect(run.logs).toContain("rolling restart ignored: one is already running");
    expect(run.logs).toContain("rolling restart ignored: the server is shutting down");
  });
});

describe("superviseWorkers — load and admission", () => {
  test("calls are the last report plus admissions since; status lists every worker", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.pong(100, 7, 0.4);
    expect(run.supervisor.admit(0, false)).toBe("ok");
    // A reconnect is a new live socket too.
    expect(run.supervisor.admit(0, true)).toBe("ok");
    expect(run.supervisor.status()[0]?.calls).toBe(9);
    run.pong(100, 8, 0.5);
    expect(run.supervisor.status()).toEqual([
      { slot: 0, pid: 100, state: "serving", calls: 8, elu: 0.5 },
      { slot: 1, pid: 101, state: "serving", calls: 0, elu: 0 },
    ]);
  });

  test("a full worker refuses every call — a claimed resume included — until it reports fewer", () => {
    const run = supervise(1, 2);
    run.listen(100);
    expect(run.supervisor.admit(0, false)).toBe("ok");
    expect(run.supervisor.admit(0, false)).toBe("ok");
    expect(run.supervisor.admit(0, false)).toBe("full");
    expect(run.supervisor.admit(0, true)).toBe("full");
    expect(run.supervisor.status()[0]?.calls).toBe(2);
    run.pong(100, 1);
    expect(run.supervisor.admit(0, false)).toBe("ok");
  });

  test("while draining a new call is refused, but a reconnect is admitted", () => {
    const run = supervise(1);
    run.listen(100);
    run.supervisor.drain(1000);
    expect(run.supervisor.admit(0, false)).toBe("draining");
    expect(run.supervisor.admit(0, true)).toBe("ok");
  });

  test("a slot with no listening worker counts nothing", () => {
    const run = supervise(1);
    expect(run.supervisor.admit(0, false)).toBe("ok");
    expect(run.supervisor.status()[0]).toMatchObject({ state: "starting", calls: 0 });
  });
});

describe("superviseWorkers — liveness", () => {
  test("pings only listening workers", () => {
    const run = supervise(2);
    run.listen(100);
    run.advance(PING_INTERVAL_MS);
    expect(run.workers[0]?.inbox).toEqual([{ type: "aai-start:ping" }]);
    expect(run.workers[1]?.inbox).toEqual([]);
  });

  test("a worker that keeps answering is never killed", () => {
    const run = supervise(1);
    run.listen(100);
    for (let t = 0; t < LIVENESS_TIMEOUT_MS * 2; t += PING_INTERVAL_MS) {
      run.advance(PING_INTERVAL_MS);
      run.pong(100);
    }
    expect(run.workers[0]?.killed).toEqual([]);
  });

  test("a worker silent for the liveness timeout is killed and respawned into its slot", () => {
    const run = supervise(2);
    run.listen(100);
    run.listen(101);
    run.advance(LIVENESS_TIMEOUT_MS - 1);
    run.pong(101);
    expect(run.workers[0]?.killed).toEqual([]);
    run.advance(1);
    expect(run.workers[0]?.killed).toEqual(["SIGKILL"]);
    expect(run.workers[1]?.killed).toEqual([]);
    expect(run.logs[0]).toMatch(/worker 0 \(pid 100\) has not answered for 15s; restarting it/);
    run.exit(100, null, "SIGKILL");
    expect(run.workers[2]?.env[SLOT_ENV]).toBe("0");
  });

  test("a slow pong is warned about, at most once per window", () => {
    const run = supervise(1);
    run.listen(100);
    run.advance(PING_INTERVAL_MS);
    run.advance(PING_INTERVAL_MS);
    run.pong(100);
    expect(run.logs).toEqual([
      "worker 0 (pid 100) answered a ping in 2500ms; its event loop is lagging",
    ]);
    run.advance(PING_INTERVAL_MS);
    run.advance(PING_INTERVAL_MS);
    run.pong(100);
    expect(run.logs).toHaveLength(1);
  });

  test("a prompt pong is not warned about", () => {
    const run = supervise(1);
    run.listen(100);
    run.advance(PING_INTERVAL_MS);
    run.pong(100);
    expect(run.logs).toEqual([]);
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
