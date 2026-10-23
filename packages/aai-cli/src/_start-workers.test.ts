// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start --workers` — the count, the `DATABASE_URL` rule, and the
 * supervisor's respawn policy, driven through a fake cluster so nothing forks.
 */

import { describe, expect, test } from "vitest";
import {
  assertWorkersSupported,
  BOOT_GRACE_MS,
  type ClusterLike,
  parseWorkers,
  resolveWorkers,
  SCHEMA_READY_ENV,
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

/** A cluster that records forks and lets a test kill a worker at a chosen time. */
function fakeCluster() {
  let nextPid = 100;
  const forks: Record<string, string>[] = [];
  let onExit: Parameters<ClusterLike["on"]>[1] = () => undefined;
  const cluster: ClusterLike = {
    fork(env = {}) {
      forks.push(env);
      return { process: { pid: nextPid++ } };
    },
    on(_event, listener) {
      onExit = listener;
    },
  };
  return {
    cluster,
    forks,
    exit: (pid: number, code = 1) => onExit({ process: { pid } }, code, null),
  };
}

function supervise(count: number) {
  let clock = 0;
  const fake = fakeCluster();
  const logs: string[] = [];
  const exits: number[] = [];
  const supervisor = superviseWorkers({
    count,
    cluster: fake.cluster,
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
    now: () => clock,
  });
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { ...fake, supervisor, logs, exits, advance };
}

describe("superviseWorkers", () => {
  test("forks the count, telling each worker the schema is applied", () => {
    const run = supervise(3);
    expect(run.forks).toEqual([
      { [SCHEMA_READY_ENV]: "1" },
      { [SCHEMA_READY_ENV]: "1" },
      { [SCHEMA_READY_ENV]: "1" },
    ]);
  });

  test("a worker that dies after booting is replaced", () => {
    const run = supervise(2);
    run.advance(BOOT_GRACE_MS + 1);
    run.exit(100);
    expect(run.forks).toHaveLength(3);
    expect(run.exits).toEqual([]);
    expect(run.logs[0]).toMatch(/worker 100 exited with code 1; starting a replacement/);
  });

  test("a worker that dies while starting stops the server instead of looping", () => {
    const run = supervise(2);
    run.exit(100);
    expect(run.forks).toHaveLength(2);
    expect(run.logs[0]).toMatch(/while starting; stopping the server/);
    expect(run.exits).toEqual([]); // its sibling is still up
    run.exit(101);
    expect(run.exits).toEqual([1]);
  });

  test("after stop() nothing respawns, and the primary exits 0 with the last worker", () => {
    const run = supervise(2);
    run.advance(BOOT_GRACE_MS + 1);
    run.supervisor.stop();
    run.exit(100, 0);
    expect(run.exits).toEqual([]);
    run.exit(101, 0);
    expect(run.forks).toHaveLength(2);
    expect(run.exits).toEqual([0]);
  });
});
