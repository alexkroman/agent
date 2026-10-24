// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start`'s three ways to serve, driven through fakes: nothing binds, forks
 * or exits for real.
 */

import { EventEmitter } from "node:events";
import { agent } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import { describe, expect, test, vi } from "vitest";
import {
  DRAIN_POLL_MS,
  runStart,
  type StartRunDeps,
  stopOnSignal,
  workerCloser,
} from "./_start-run.ts";
import type { PrimaryLink } from "./_start-worker.ts";
import type { ClusterLike, WorkerLike, WorkerMessage } from "./_start-workers.ts";

function fakeServer(port = 3000): AgentServer {
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

/** A cluster whose workers all report listening as soon as they are forked. */
function eagerCluster(): ClusterLike & { workers: WorkerLike[] } {
  let onMessage: Parameters<ClusterLike["onMessage"]>[0] = () => undefined;
  const workers: WorkerLike[] = [];
  return {
    workers,
    fork() {
      const worker: WorkerLike = {
        pid: workers.length + 1,
        kill: () => undefined,
        send: () => undefined,
      };
      workers.push(worker);
      queueMicrotask(() =>
        onMessage(worker, { type: "aai-start:listening", name: "Voice", port: 9000 }),
      );
      return worker;
    },
    onExit: () => undefined,
    onMessage: (listener) => {
      onMessage = listener;
    },
  };
}

function harness(over: Partial<StartRunDeps> = {}) {
  const log: string[] = [];
  const exits: number[] = [];
  const sent: WorkerMessage[] = [];
  let signal: ((s: NodeJS.Signals) => void) | undefined;
  let ignored = 0;
  let slept = 0;
  const link: PrimaryLink = { send: (m) => sent.push(m), onMessage: () => undefined };
  const deps: StartRunDeps = {
    isWorker: false,
    slot: () => ({ slot: 0, slots: 2 }),
    load: async () => ({ agent: agent({ name: "Voice" }), env: {} }),
    build: async () => fakeServer(),
    readEnv: async () => ({}),
    assertBuilt: () => undefined,
    startTracing: async () => undefined,
    cluster: eagerCluster,
    link: () => link,
    listen: async () => 4444,
    onSignal: (handler) => {
      signal = handler;
    },
    exit: (code) => exits.push(code),
    stop: async () => undefined,
    forever: () => new Promise<never>(() => undefined),
    ignoreSignals: () => {
      ignored += 1;
    },
    sleep: async (ms) => {
      slept += ms;
    },
    ui: {
      info: (m) => log.push(`info ${m}`),
      error: (m) => log.push(`error ${m}`),
      notify: (level, m) => log.push(`${level} ${m}`),
    },
    ...over,
  };
  return {
    deps,
    log,
    exits,
    sent,
    signal: (s: NodeJS.Signals) => signal?.(s),
    ignored: () => ignored,
    slept: () => slept,
  };
}

describe("runStart — one process", () => {
  test("builds, binds, announces, and answers the bound port", async () => {
    const h = harness();
    await expect(
      runStart(
        { port: 3000, host: undefined, workers: 1, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
        h.deps,
      ),
    ).resolves.toEqual({
      ok: true,
      data: { name: "Voice", port: 3000, workers: 1 },
    });
    expect(h.log).toContain("info Voice listening on http://127.0.0.1:3000");
  });
});

describe("stopOnSignal", () => {
  test("a second signal does nothing: one shutdown, one exit 0", async () => {
    const stop = vi.fn(async () => undefined);
    const h = harness({ stop });
    stopOnSignal(fakeServer(), undefined, h.deps);
    h.signal("SIGINT");
    h.signal("SIGINT");
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("a failed shutdown is reported and exits 1", async () => {
    const h = harness({ stop: async () => Promise.reject(new Error("close failed")) });
    stopOnSignal(fakeServer(), undefined, h.deps);
    h.signal("SIGTERM");
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.log).toContain("error shutdown failed: close failed");
  });
});

describe("runStart — a --workers worker", () => {
  test("joins its primary and never settles (it prints no result of its own)", async () => {
    const h = harness({ isWorker: true });
    let settled = false;
    void runStart(
      { port: 0, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
      h.deps,
    ).then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(h.sent).toContainEqual({ type: "aai-start:listening", name: "Voice", port: 3000 }),
    );
    expect(settled).toBe(false);
  });

  test("a failure goes to the primary alone (it reports it once), and exits 1", async () => {
    const h = harness({
      isWorker: true,
      build: async () => Promise.reject(new Error("bad bundle")),
    });
    void runStart(
      { port: 0, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
      h.deps,
    );
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.log).toEqual([]);
    expect(h.sent).toContainEqual({ type: "aai-start:fatal", message: "bad bundle" });
  });

  test("a failure before runWorker (tracing) still reaches the primary", async () => {
    const h = harness({
      isWorker: true,
      startTracing: async () => Promise.reject(new Error("bad collector")),
    });
    void runStart(
      { port: 0, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
      h.deps,
    );
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.sent).toEqual([{ type: "aai-start:fatal", message: "bad collector" }]);
  });

  test("says it has booted only once it is listening", async () => {
    const order: string[] = [];
    const h = harness({
      isWorker: true,
      booted: () => order.push("booted"),
      link: () => ({ send: (m) => order.push(m.type), onMessage: () => undefined }),
    });
    void runStart(
      { port: 0, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
      h.deps,
    );
    await vi.waitFor(() => expect(order).toContain("booted"));
    expect(order).toEqual(["aai-start:listening", "booted"]);
  });
});

describe("runStart — the --workers primary", () => {
  test("warns once without a database, then announces the bound port and worker count", async () => {
    const h = harness();
    await expect(
      runStart(
        { port: 3000, host: "0.0.0.0", workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
        h.deps,
      ),
    ).resolves.toEqual({
      ok: true,
      data: { name: "Voice", port: 4444, workers: 2 },
    });
    // After the announcement: a worker refusing to boot must not be preceded
    // by a warning promising that reconnects resume.
    expect(h.log).toEqual([
      "info Voice listening on http://0.0.0.0:4444 with 2 workers",
      expect.stringMatching(/^warn No DATABASE_URL: each of the 2 workers/),
    ]);
  });

  test("with a database there is no warning", async () => {
    const h = harness({ readEnv: async () => ({ DATABASE_URL: "postgres://x" }) });
    await runStart(
      { port: 3000, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
      h.deps,
    );
    expect(h.log.some((l) => l.startsWith("warn"))).toBe(false);
  });

  test("no build fails before anything is forked", async () => {
    const cluster = eagerCluster();
    const h = harness({
      assertBuilt: () => {
        throw new Error("No built agent");
      },
      cluster: () => cluster,
    });
    await expect(
      runStart(
        { port: 3000, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
        h.deps,
      ),
    ).rejects.toThrow(/No built agent/);
    expect(cluster.workers).toEqual([]);
  });
});

describe("runStart — a --workers worker ignores signals", () => {
  test("its primary owns its lifecycle, so it installs no-op signal handlers first", async () => {
    const h = harness({ isWorker: true });
    void runStart(
      { port: 0, host: undefined, workers: 2, drainTimeoutMs: 30_000, maxCallsPerWorker: 100 },
      h.deps,
    );
    await vi.waitFor(() => expect(h.sent.some((m) => m.type === "aai-start:listening")).toBe(true));
    expect(h.ignored()).toBe(1);
  });
});

describe("workerCloser", () => {
  test("a drain waits for the calls to end, then closes and exits 0", async () => {
    let calls = 2;
    const stop = vi.fn(async () => undefined);
    const h = harness({
      stop,
      sleep: async () => {
        calls -= 1;
      },
    });
    workerCloser(fakeServer(), () => calls, undefined, h.deps)(60_000);
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(calls).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("a drain gives up at its timeout with calls still live", async () => {
    let slept = 0;
    const h = harness({
      sleep: async (ms) => {
        slept += ms;
      },
    });
    workerCloser(fakeServer(), () => 5, undefined, h.deps)(DRAIN_POLL_MS * 4);
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(slept).toBe(DRAIN_POLL_MS * 4);
  });

  test("a stop arriving mid-drain cuts the wait short; closing happens once", async () => {
    let close: (graceMs: number) => void = () => undefined;
    let polls = 0;
    const stop = vi.fn(async () => undefined);
    const h = harness({
      stop,
      sleep: async () => {
        polls += 1;
        if (polls === 2) close(0);
      },
    });
    close = workerCloser(fakeServer(), () => 3, undefined, h.deps);
    close(600_000);
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(polls).toBe(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("a failed close is reported and exits 1", async () => {
    const h = harness({ stop: async () => Promise.reject(new Error("nope")) });
    workerCloser(fakeServer(), () => 0, undefined, h.deps)(0);
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.log).toContain("error shutdown failed: nope");
  });
});
