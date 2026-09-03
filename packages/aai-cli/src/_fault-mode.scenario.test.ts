// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for fault mode.
 *
 * Scenario tier because it spawns real child processes, binds real sockets
 * and hard-kills them — the three things it exists to do.
 *
 * The server under supervision is a FAKE, not `aai dev`, and it needs no seam to
 * be: `startSupervisedDevServer` spawns `<aaiBin> dev --port <n>`, so a script
 * that ignores those arguments, serves `/health` and prints on a schedule is a
 * drop-in. That keeps these specs about the supervisor — does it kill, at the
 * declared point, and does it notice when it did not — rather than about a
 * project building.
 *
 * The case that matters most is {@link assertPlanConsumed}: a fault mode whose
 * triggers stopped matching would run a whole suite injecting nothing and pass,
 * which is indistinguishable from a healthy run.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleep } from "@alexkroman1/aai/internal";
import getPort, { portNumbers } from "get-port";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveFaultProfile,
  type SupervisedServer,
  startSupervisedDevServer,
} from "./_fault-mode.ts";

/**
 * A stand-in dev server: serves `/health`, announces its own pid, then prints a
 * `TICK` line every 150ms so an `nth` trigger is reachable.
 *
 * It retries the bind, because a SIGKILLed predecessor's socket is not always
 * released by the time its replacement starts — a real race, and one `aai dev`
 * handles for itself (see its restart state machine).
 */
const FAKE_SERVER = `
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", pid: process.pid }));
});
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  setTimeout(() => server.listen(port, "127.0.0.1"), 100);
});
server.listen(port, "127.0.0.1", () => {
  console.log("listening pid=" + process.pid);
  let n = 0;
  setInterval(() => { console.log("TICK " + ++n + " pid=" + process.pid); }, 150);
});
`;

/**
 * The same server with NO output at all.
 *
 * This is the shape that broke the first boot profile: `aai dev` announces
 * itself through `log.success`, which JSON mode silences — and JSON mode is what
 * the e2e suite runs — so a log-keyed boot trigger matched nothing and the mode
 * injected no faults. An `afterHealthy` point has to work against a server that
 * says nothing ever.
 */
const SILENT_SERVER = `
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404).end("{}");
});
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  setTimeout(() => server.listen(port, "127.0.0.1"), 100);
});
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

/**
 * A server that listens on its FIRST run and exits immediately on every one
 * after — a process that does not survive the kill this mode inflicts.
 *
 * The marker file is what carries "first run" across the SIGKILL, since each
 * generation is a fresh process. Written per port so tests do not share it.
 */
const DYING_SERVER = `
const fs = require("node:fs");
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const marker = process.env.AAI_FAULT_TEST_MARKER;
if (fs.existsSync(marker)) { console.log("refusing to come back"); process.exit(1); }
fs.writeFileSync(marker, "1");
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404).end("{}");
});
server.listen(port, "127.0.0.1", () => {
  console.log("listening pid=" + process.pid);
  setInterval(() => { console.log("TICK pid=" + process.pid); }, 150);
});
`;

let fakeBin: string | undefined;
let silentBin: string | undefined;
let tmpDir: string | undefined;
let server: SupervisedServer | undefined;

/**
 * A free port high enough to sit clear of the other servers these suites run.
 *
 * `get-port` rather than a hand-incremented counter: an occupied 4861 was an
 * EADDRINUSE flake that the fake server's bind retry papered over instead of
 * avoiding, and the retry is there for the SIGKILL race, not for a port
 * somebody else owns.
 */
async function nextFreePort(): Promise<number> {
  return getPort({ port: portNumbers(4861, 4961) });
}

/** Discriminates the per-test fixture FILE names; not a port. */
let fixtureSeq = 0;

async function fake(): Promise<string> {
  if (fakeBin) return fakeBin;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-fault-"));
  fakeBin = path.join(tmpDir, "fake-dev.cjs");
  await fs.writeFile(fakeBin, FAKE_SERVER);
  return fakeBin;
}

async function silent(): Promise<string> {
  if (silentBin) return silentBin;
  await fake(); // for tmpDir
  silentBin = path.join(tmpDir ?? os.tmpdir(), "silent-dev.cjs");
  await fs.writeFile(silentBin, SILENT_SERVER);
  return silentBin;
}

async function dying(): Promise<string> {
  await fake(); // for tmpDir
  const bin = path.join(tmpDir ?? os.tmpdir(), `dying-dev-${++fixtureSeq}.cjs`);
  await fs.writeFile(bin, DYING_SERVER);
  return bin;
}

async function supervise(
  profile: Parameters<typeof startSupervisedDevServer>[0]["profile"],
  bin?: string,
) {
  return startSupervisedDevServer({
    aaiBin: bin ?? (await fake()),
    cwd: tmpDir ?? os.tmpdir(),
    port: await nextFreePort(),
    env: process.env,
    profile,
  });
}

/** Distinct pids across the whole log — one per generation that ever listened. */
function pids(s: SupervisedServer): string[] {
  const seen = new Set<string>();
  for (const line of s.lines()) {
    const match = /pid=(\d+)/.exec(line);
    if (match?.[1]) seen.add(match[1]);
  }
  return [...seen];
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

// The fixture scripts live in one temp dir shared by the whole file; without
// this every run left an `aai-fault-*` directory behind in `tmpdir()`.
afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
  fakeBin = undefined;
  silentBin = undefined;
});

describe("resolveFaultProfile", () => {
  test.each([undefined, "", "none"])("%o leaves the mode off", (name) => {
    expect(resolveFaultProfile(name)).toBeUndefined();
  });

  test("an unknown name THROWS naming the declared set", () => {
    // Never degrade to off: a typo would otherwise produce a green run that
    // injected nothing, which reads exactly like a healthy one.
    expect(() => resolveFaultProfile("restart-mid-stepp")).toThrow(/Declared: /);
  });

  test("a declared name resolves to its points", () => {
    expect(resolveFaultProfile("restart-on-run-start")?.points).toHaveLength(1);
  });
});

describe("supervision", () => {
  test("with no profile it is an ordinary spawn: no kills, one process", async () => {
    server = await supervise(undefined);
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    // Give it long enough that a stray trigger would have fired.
    await sleep(600);
    expect(server.restarts()).toBe(0);
    expect(pids(server)).toHaveLength(1);
    // Vacuously consumed — an empty plan is fully injected.
    expect(() => server?.assertPlanConsumed()).not.toThrow();
  });

  test("a fault point kills at the declared line and the server comes back", async () => {
    server = await supervise({
      description: "one kill on the first tick",
      points: [{ after: "TICK" }],
    });
    await vi.waitFor(() => expect(server?.restarts()).toBe(1), { timeout: 15_000 });
    // Back up and answering, on the same URL, as a DIFFERENT process.
    await vi.waitFor(async () => expect((await fetch(`${server?.url}/health`)).status).toBe(200), {
      timeout: 15_000,
    });
    expect(pids(server)).toHaveLength(2);
    expect(() => server?.assertPlanConsumed()).not.toThrow();
  });

  test("`nth` counts occurrences ACROSS restarts", async () => {
    // The regression this pins: counting inside the point loop, and skipping
    // points that had already fired, stopped a pattern advancing once its first
    // point fired — so the second of these two never came up and the whole
    // profile silently injected one kill instead of two.
    server = await supervise({
      description: "two kills on one pattern",
      points: [
        { after: "TICK", nth: 1 },
        { after: "TICK", nth: 3 },
      ],
    });
    await vi.waitFor(() => expect(server?.restarts()).toBe(2), { timeout: 20_000 });
    expect(() => server?.assertPlanConsumed()).not.toThrow();
    expect(pids(server)).toHaveLength(3);
  });

  test("assertPlanConsumed THROWS when a declared point never matched", async () => {
    server = await supervise({
      description: "a pattern nothing prints",
      points: [{ after: "NO SUCH LINE" }],
    });
    await sleep(800);
    expect(server.restarts()).toBe(0);
    expect(() => server?.assertPlanConsumed()).toThrow(/injected 0 of 1 fault/);
    expect(() => server?.assertPlanConsumed()).toThrow(/"NO SUCH LINE"/);
  });

  test("it names the shortfall when SOME points fired", async () => {
    server = await supervise({
      description: "one reachable, one not",
      points: [{ after: "TICK" }, { after: "NEVER PRINTED" }],
    });
    await vi.waitFor(() => expect(server?.restarts()).toBe(1), { timeout: 15_000 });
    expect(() => server?.assertPlanConsumed()).toThrow(/injected 1 of 2 fault/);
  });

  test("`afterHealthy` fires against a server that prints NOTHING", async () => {
    // The regression: a boot trigger keyed on a log line is unreachable under
    // JSON mode, which is what the e2e suite runs. This has no log to key on at
    // all, so it can only pass if the trigger is the supervisor's own health
    // observation.
    server = await supervise(
      { description: "kill after the first boot", points: [{ afterHealthy: 1 }] },
      await silent(),
    );
    await vi.waitFor(() => expect(server?.restarts()).toBe(1), { timeout: 15_000 });
    expect(server.lines()).toHaveLength(0);
    expect(() => server?.assertPlanConsumed()).not.toThrow();
  });

  test("the shipped `restart-on-boot` profile settles at two restarts", async () => {
    // The suite-wide profile, driven end to end: every supervised server boots,
    // so this is the one that can be claimed to reach every test.
    server = await supervise(resolveFaultProfile("restart-on-boot"), await silent());
    await server.awaitSettled(30_000);
    expect(server.restarts()).toBe(2);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  test("awaitSettled throws naming the shortfall AND the lines it did see", async () => {
    server = await supervise({
      description: "a pattern nothing prints",
      points: [{ after: "NO SUCH LINE" }],
    });
    await expect(server.awaitSettled(2000)).rejects.toThrow(/Last lines seen/);
  });

  test("a restart that never becomes healthy is REPORTED, not an unhandled rejection", async () => {
    // `cycle = cycle.then(() => recycle(point))` left a rejected promise with
    // no handler for as long as it took the suite to reach `stop()` — seconds —
    // and Node reports that as an unhandledRejection, which under vitest fails
    // whichever test happens to be running and names the wrong thing. The
    // failure is now recorded when it happens and re-raised here, which is what
    // `stop`'s comment always intended: reported rather than swallowed.
    const marker = path.join(tmpDir ?? os.tmpdir(), `marker-${++fixtureSeq}`);
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      server = await startSupervisedDevServer({
        aaiBin: await dying(),
        cwd: tmpDir ?? os.tmpdir(),
        port: await nextFreePort(),
        env: { ...process.env, AAI_FAULT_TEST_MARKER: marker },
        profile: { description: "kill the one boot it has", points: [{ afterHealthy: 1 }] },
        // Otherwise this assertion costs the shipped 60s health budget.
        healthTimeoutMs: 2000,
      });

      await expect(server.awaitSettled(20_000)).rejects.toThrow(/never became healthy/);
      // Nothing reached the process-level handler on the way.
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stop() during a pending kill cycle does not leave a process behind", async () => {
    server = await supervise({ description: "kill on tick", points: [{ after: "TICK" }] });
    // Stop while the kill/restart cycle is plausibly mid-flight.
    await server.stop();
    const stopped = server;
    server = undefined;
    // The URL must stop answering: nothing was left listening.
    await vi.waitFor(
      async () => {
        await expect(fetch(`${stopped.url}/health`)).rejects.toThrow();
      },
      { timeout: 15_000 },
    );
  });
});
