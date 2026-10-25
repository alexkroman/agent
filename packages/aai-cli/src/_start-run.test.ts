// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start`'s three ways to serve — one process, the `--workers` primary and
 * a worker — driven through fakes: nothing binds, forks or exits for real.
 */

import type http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { agent, workflow } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  bindError,
  DRAIN_POLL_MS,
  runStart,
  type StartRunDeps,
  type StartTarget,
  stopOnSignal,
  workerCloser,
} from "./_start-run.ts";
import { fakeCluster, fakeLink, fakeServer } from "./_start-test-utils.ts";

const voiceAgent = agent({ name: "Voice" });
const workflowAgent = agent({
  name: "Flows",
  workflows: { ping: workflow({ input: z.object({}), run: async () => ({}) }) },
});

const single: StartTarget = {
  port: 3000,
  host: undefined,
  workers: 1,
  drainTimeoutMs: 30_000,
  maxCallsPerWorker: 100,
};
const primary: StartTarget = { ...single, workers: 2 };

function addressInUse(): Error {
  return Object.assign(new Error("listen EADDRINUSE: address already in use"), {
    code: "EADDRINUSE",
  });
}

function harness(over: Partial<StartRunDeps> = {}, cluster = fakeCluster({ eager: true })) {
  const log: string[] = [];
  const exits: number[] = [];
  const link = fakeLink();
  const order: string[] = [];
  let router: http.Server | undefined;
  let signal: ((s: NodeJS.Signals) => void) | undefined;
  let ignored = 0;
  const deps: StartRunDeps = {
    isWorker: false,
    slot: () => ({ slot: 0, slots: 2 }),
    load: async () => ({ agent: voiceAgent, env: {} }),
    build: async () => fakeServer(3000),
    readEnv: async () => ({}),
    assertBuilt: () => undefined,
    startTracing: async () => undefined,
    cluster: () => {
      order.push("fork");
      return cluster.cluster;
    },
    link: () => link.link,
    runtime: {
      setSessionIdMinter: () => undefined,
      setClientNotifyRelay: () => undefined,
      notifyClientHere: async () => "offline",
    },
    listen: async (server) => {
      order.push("listen");
      router = server;
      return 4444;
    },
    onSignal: (handler) => {
      signal = handler;
    },
    exit: (code) => exits.push(code),
    stop: async () => undefined,
    forever: () => new Promise<never>(() => undefined),
    ignoreSignals: () => {
      ignored += 1;
    },
    sleep: async () => undefined,
    ui: {
      info: (m) => log.push(`info ${m}`),
      error: (m) => log.push(`error ${m}`),
      notify: (level, m) => log.push(`${level} ${m}`),
    },
    ...over,
  };
  /** Send one request through the primary's router; resolves with the status it answered. */
  const request = (method: string, url: string) => {
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = url;
    req.headers = {};
    req.push(null);
    const res = new ServerResponse(req);
    const writeHead = vi.spyOn(res, "writeHead");
    const ended = new Promise<void>((resolve) => {
      vi.spyOn(res, "end").mockImplementation(() => {
        resolve();
        return res;
      });
    });
    router?.emit("request", req, res);
    return ended.then(() => writeHead.mock.calls[0]?.[0]);
  };
  /** Send one upgrade through the primary's router; whether any worker was handed it. */
  const handoffs = () =>
    cluster.workers.flatMap((w) => w.inbox).filter((m) => m.type === "aai-start:upgrade").length;
  const upgrade = (url: string) => {
    const before = handoffs();
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = url;
    req.httpVersion = "1.1";
    req.headers = { host: "h" };
    req.rawHeaders = ["host", "h"];
    const socket = new Socket();
    vi.spyOn(socket, "end").mockImplementation(() => socket);
    router?.emit("upgrade", req, socket, Buffer.alloc(0));
    socket.destroy();
    return handoffs() > before;
  };
  return {
    deps,
    cluster,
    log,
    exits,
    sent: link.sent,
    order,
    request,
    upgrade,
    signal: (s: NodeJS.Signals) => signal?.(s),
    ignored: () => ignored,
  };
}

describe("runStart — one process", () => {
  test("builds, binds, announces, and answers the bound port", async () => {
    const h = harness();
    await expect(runStart(single, h.deps)).resolves.toEqual({
      ok: true,
      data: { name: "Voice", port: 3000, workers: 1 },
    });
    expect(h.log).toContain("info Voice listening on http://127.0.0.1:3000");
  });

  test("a port in use is named, with the remedy", async () => {
    const server = fakeServer();
    server.listen = async () => Promise.reject(addressInUse());
    const h = harness({ build: async () => server });
    await expect(runStart(single, h.deps)).rejects.toThrow(
      "port 3000 is in use; pass --port or set PORT",
    );
  });
});

describe("bindError", () => {
  test("rewrites only EADDRINUSE, keeping the original as the cause", () => {
    const raw = addressInUse();
    const named = bindError(raw, 4920);
    expect(named).toMatchObject({
      message: "port 4920 is in use; pass --port or set PORT",
      cause: raw,
    });
    const other = new Error("EACCES");
    expect(bindError(other, 80)).toBe(other);
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
  const asWorker = (over: Partial<StartRunDeps> = {}) => {
    const h = harness({ isWorker: true, ...over });
    let settled = false;
    void runStart({ ...primary, port: 0 }, h.deps).then(() => {
      settled = true;
    });
    return { ...h, settled: () => settled };
  };

  test("ignores signals, joins its primary, and never settles (it prints no result)", async () => {
    const h = asWorker();
    await vi.waitFor(() =>
      expect(h.sent).toContainEqual({ type: "aai-start:listening", name: "Voice", port: 3000 }),
    );
    expect(h.settled()).toBe(false);
    expect(h.ignored()).toBe(1);
  });

  test("says it has booted only once it is listening", async () => {
    const order: string[] = [];
    asWorker({
      booted: () => order.push("booted"),
      link: () => ({ send: (m) => order.push(m.type), onMessage: () => undefined }),
    });
    await vi.waitFor(() => expect(order).toContain("booted"));
    expect(order).toEqual(["aai-start:listening", "booted"]);
  });

  test("a failure goes to the primary alone (it reports it once), and exits 1", async () => {
    const h = asWorker({ build: async () => Promise.reject(new Error("bad bundle")) });
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.log).toEqual([]);
    expect(h.sent).toEqual([{ type: "aai-start:fatal", message: "bad bundle" }]);
  });

  test("a failure before the build (tracing) still reaches the primary", async () => {
    const h = asWorker({ startTracing: async () => Promise.reject(new Error("bad collector")) });
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.sent).toEqual([{ type: "aai-start:fatal", message: "bad collector" }]);
  });

  test("refuses workflows without a database, telling the primary why, before building", async () => {
    const build = vi.fn(async () => fakeServer());
    const h = asWorker({ load: async () => ({ agent: workflowAgent, env: {} }), build });
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(build).not.toHaveBeenCalled();
    expect(h.sent).toEqual([
      {
        type: "aai-start:fatal",
        message: expect.stringMatching(/on 2 workers needs DATABASE_URL/),
      },
    ]);
  });

  test("workflows WITH a database are served", async () => {
    const h = asWorker({
      load: async () => ({ agent: workflowAgent, env: { DATABASE_URL: "postgres://x" } }),
    });
    await vi.waitFor(() => expect(h.sent[0]?.type).toBe("aai-start:listening"));
    expect(h.exits).toEqual([]);
  });
});

describe("runStart — the --workers primary", () => {
  test("warns once without a database, after announcing the bound port and worker count", async () => {
    const h = harness();
    await expect(runStart({ ...primary, host: "0.0.0.0" }, h.deps)).resolves.toEqual({
      ok: true,
      data: { name: "Agent", port: 4444, workers: 2 },
    });
    // After the announcement: a worker refusing to boot must not be preceded
    // by a warning promising that reconnects resume.
    expect(h.log).toEqual([
      "info Agent listening on http://0.0.0.0:4444 with 2 workers",
      expect.stringMatching(/^warn No DATABASE_URL: each of the 2 workers/),
    ]);
  });

  test("with a database there is no warning", async () => {
    const h = harness({ readEnv: async () => ({ DATABASE_URL: "postgres://x" }) });
    await runStart(primary, h.deps);
    expect(h.log.some((l) => l.startsWith("warn"))).toBe(false);
  });

  test("no build fails before anything is bound or forked", async () => {
    const h = harness({
      assertBuilt: () => {
        throw new Error("No built agent");
      },
    });
    await expect(runStart(primary, h.deps)).rejects.toThrow(/No built agent/);
    expect(h.order).toEqual([]);
  });

  test("binds before forking; until every slot listens it routes nothing and /health says starting", async () => {
    const h = harness({}, fakeCluster());
    const running = runStart(primary, h.deps);
    await vi.waitFor(() => expect(h.cluster.workers).toHaveLength(2));
    expect(h.order).toEqual(["listen", "fork"]);
    h.cluster.listen(100);
    expect(await h.request("GET", "/health")).toBe(503);
    expect(await h.request("GET", "/api/x")).toBe(503);
    h.cluster.listen(101);
    await expect(running).resolves.toMatchObject({ data: { name: "Agent", port: 4444 } });
  });

  test("a port in use fails before anything is forked, naming the port", async () => {
    const h = harness({ listen: async () => Promise.reject(addressInUse()) });
    await expect(runStart(primary, h.deps)).rejects.toThrow(
      "port 3000 is in use; pass --port or set PORT",
    );
    expect(h.cluster.workers).toEqual([]);
  });

  test("a worker that fails to boot rejects with its reason", async () => {
    const h = harness({}, fakeCluster());
    const running = runStart(primary, h.deps);
    await vi.waitFor(() => expect(h.cluster.workers).toHaveLength(2));
    h.cluster.say(100, { type: "aai-start:fatal", message: "bad bundle" });
    h.cluster.exit(100, 1);
    h.cluster.exit(101, 0);
    await expect(running).rejects.toThrow(/bad bundle/);
    expect(h.exits).toEqual([]);
  });

  test("a first signal drains every worker and fails /health; the process exits with their verdict", async () => {
    const h = harness();
    await runStart(primary, h.deps);
    expect(await h.request("GET", "/health")).not.toBe(503);
    h.signal("SIGTERM");
    expect(h.cluster.workers.map((w) => w.inbox.at(-1))).toEqual([
      { type: "aai-start:drain", timeoutMs: 30_000 },
      { type: "aai-start:drain", timeoutMs: 30_000 },
    ]);
    expect(await h.request("GET", "/health")).toBe(503);
    for (const w of h.cluster.workers) h.cluster.exit(w.pid, 0);
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
  });

  test("a second signal stops at once", async () => {
    const h = harness();
    await runStart(primary, h.deps);
    h.signal("SIGINT");
    h.signal("SIGINT");
    expect(h.cluster.workers[0]?.inbox.at(-1)).toEqual({ type: "aai-start:stop" });
  });

  test("SIGHUP starts a rolling restart: a replacement is forked for slot 0", async () => {
    const h = harness({}, fakeCluster());
    const running = runStart(primary, h.deps);
    await vi.waitFor(() => expect(h.cluster.workers).toHaveLength(2));
    h.cluster.listenAll();
    await running;
    h.signal("SIGHUP");
    expect(h.cluster.workers).toHaveLength(3);
  });
});

describe("runStart — the primary's admission policy", () => {
  async function primaryWith(maxCallsPerWorker: number) {
    const h = harness();
    await runStart({ ...primary, maxCallsPerWorker }, h.deps);
    return h;
  }

  test("a made-up ?sessionId= does not get a call past the per-worker cap", async () => {
    const h = await primaryWith(1);
    // One client, so every call lands on the same worker.
    expect(h.upgrade("/websocket?client=a")).toBe(true);
    expect(h.upgrade("/websocket?client=a")).toBe(false);
    expect(h.upgrade(`/websocket?client=a&sessionId=${crypto.randomUUID()}`)).toBe(false);
  });

  test("while draining, a new call is refused but a reconnect still routes", async () => {
    const h = await primaryWith(100);
    h.signal("SIGTERM");
    expect(h.upgrade("/websocket?client=a")).toBe(false);
    expect(h.upgrade(`/websocket?client=a&sessionId=${crypto.randomUUID()}`)).toBe(true);
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
