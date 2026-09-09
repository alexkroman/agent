// Copyright 2026 the AAI authors. MIT license.
/**
 * The self-hosted server, under every runtime it claims to run on.
 *
 * `node`, `deno` and `bun` — one emitted directory, booted three times, with a
 * real session dialled on each. Scenario tier because every arm is: a rolldown
 * pass over the whole runtime, and a subprocess that boots the result. A
 * subprocess rather than an in-process import for the reason the Vercel, Deno
 * and Modal suites give — booting an agent server starts a runtime whose only
 * shutdown door is `AgentServer.close()`, and the emitted module exports
 * nothing.
 *
 * ## What this suite owns that the host suites do not
 *
 * `_deno-output.scenario.test.ts` and `_modal-output.scenario.test.ts` each
 * prove a HOST: that Deploy's directory boots under Deno, that Modal's boots
 * under node, that the descriptor each emits is the one its tooling reads. Two
 * things fell between them, and both are properties of the ARTIFACT rather
 * than of a host:
 *
 * - **No runtime but the emitting host's was ever run.** The emitted directory
 *   is a container payload — no `node_modules`, no toolchain, one file to run
 *   — and which runtime an operator puts in that image is their choice, not
 *   ours. The entry was per-host until `_target-entry.ts`, and the Deno copy
 *   read `PORT` through `globalThis.Deno.env` and nothing else, so that
 *   directory ignored `PORT` under `node` and `bun` while looking perfectly
 *   healthy on the default. Nothing here could see that.
 * - **Nothing dialled a session.** All three host suites probe HTTP only. The
 *   `/websocket` upgrade is how every browser and every phone call reaches the
 *   agent, it goes through `ws` over a `node:http` server, and a runtime's
 *   upgrade path is exactly the part of `node:http` compatibility a
 *   reimplementation is most likely to get wrong. `_deno-target.ts` records
 *   that leg as "verified against a live deployment with real speech" — by
 *   hand, once, on one runtime.
 *
 * ## Why a synthetic target is the subject
 *
 * The precedent is `_target-output.test.ts`: asserting the shared emit through
 * one real host makes the result that host's behaviour observed once, where a
 * synthetic target makes it the contract both emits rest on.
 * `_target-entry.test.ts` pins the two real entries to this same body modulo a
 * banner and a port, so a claim proved here is a claim about both.
 *
 * ## Bun needed a FLOOR, and the matrix is what found it
 *
 * Under Bun 1.3.x the emit did not work, in two separate ways, and neither was
 * visible to anything else here. It died on IMPORT — undici assigns
 * `webidl.util.markAsUncloneable` unguarded from `node:worker_threads`, which
 * Bun did not implement, and undici's own `CacheStorage` calls it at module
 * scope. Past that, the `/websocket` upgrade never reached the client: our
 * handler logged `WS upgrade /websocket`, `ws`'s `handleUpgrade` callback ran,
 * a session was created — and then nothing was written. Measured with a raw
 * socket: an upgrade request to a Bun-hosted `ws` server received ZERO bytes,
 * no `101` and no error, so a browser sat in CONNECTING until it gave up.
 *
 * Both close at **1.4.0**, which is why `minVersion` is a declaration here
 * rather than a note somewhere:
 *
 * | Bun | `markAsUncloneable` | `ws` upgrade |
 * | --- | --- | --- |
 * | 1.3.11, 1.3.12, 1.3.14 | absent | zero bytes |
 * | 1.4.0, 1.4.2 | present | completes |
 *
 * The second one is worth remembering for the shape rather than the fix. It was
 * never a general gap in Bun's `node:http`: the same nine-line `ws` +
 * `node:http` server worked under Bun 1.3.11 when `ws` was imported by NAME,
 * because **Bun substitutes its own native implementation for the `ws`
 * package** — and failed identically to the emit when the same script imported
 * ws's real JavaScript by path. A bundle inlines that JavaScript, so the
 * substitution never happens and only the real library runs. Any future
 * "works outside a bundle, not inside it" report on Bun starts there.
 *
 * A binary below the floor is treated as an ABSENT one (announced, skipped,
 * and a hard failure under `AAI_REQUIRE_BUN`) rather than run — see
 * `BinaryGate.minVersion`. Discovering the floor a second time, three
 * assertions deep, is what that avoids.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { FEATURE_DETECTED_NODE_BUILTINS, PORTABLE_NODE_BUILTINS } from "./_target-bundle.ts";
import { longLivedEntrySource } from "./_target-entry.ts";
import { emitSelfContainedOutput, type SelfContainedTarget } from "./_target-output.ts";
import {
  type BinaryGate,
  describeWithBinary,
  linkProjectNodeModules,
  silenced,
} from "./_test-utils.ts";

/** Never bound — every arm passes `PORT`, and the fallback is what proves it is read. */
const UNUSED_DEFAULT_PORT = 8000;

/** The emit under test: nobody's host, so no arm can lean on one's quirks. */
const TARGET: SelfContainedTarget = {
  outputDir: path.join(".aai", "runtimes"),
  entryFile: "server.mjs",
  entrySource: longLivedEntrySource({
    target: "node",
    hostNote: ["A long-lived host runs this and expects it to listen."],
    defaultPort: UNUSED_DEFAULT_PORT,
  }),
  name: "runtimes",
};

/** One runtime in the matrix, and how it runs a file. */
interface Runtime {
  readonly gate: BinaryGate;
  /** Argv for running `file`, minus the binary. */
  readonly argv: (file: string) => string[];
  /** The port this runtime's arms bind — distinct, so the six arms cannot collide. */
  readonly port: number;
  /**
   * Whether a browser can DIAL this runtime, i.e. whether the `/websocket`
   * upgrade completes. True for all three now; it was Bun's floor that made
   * this a per-runtime field, and the field stays because the next runtime's
   * answer is a measurement rather than an assumption.
   */
  readonly acceptsSessions: boolean;
  /** The oldest version this arm asserts, when the runtime needs a floor. */
  readonly minVersion?: string;
}

const RUNTIMES: readonly Runtime[] = [
  {
    // Ungated: `node` is running this suite. It is in the matrix regardless,
    // because the claim is about the artifact rather than about the machine —
    // and because leaving it out would mean the one runtime nobody doubts is
    // also the one nothing asserts, which is how the Deno arm's own port bug
    // survived (the Modal suite boots under node and reads PORT correctly, so
    // only the SHARED entry closes it for both).
    // `AAI_REQUIRE_NODE` is deliberately NOT declared in `turbo.json`, unlike
    // the two below: a missing `node` could not have started vitest, so there
    // is no skip here to convert into a failure.
    gate: { bin: "node", requireEnv: "AAI_REQUIRE_NODE", howTo: "Install Node 24 or newer." },
    argv: (file) => [file],
    port: 8821,
    acceptsSessions: true,
  },
  {
    gate: {
      bin: "deno",
      requireEnv: "AAI_REQUIRE_DENO",
      howTo:
        "Install Deno (`brew install deno`, or `curl -fsSL https://deno.land/install.sh | sh`).\n" +
        "CI's integration-and-scenario job pins one via denoland/setup-deno.",
    },
    // `-A` for the reason `DENO_CONFIG_SOURCE` gives: the server binds a port,
    // reads the client directory and the worker off disk, and reads the
    // environment, so an enumerated permission set here would be a second
    // declaration of the runtime's needs that drifts from the first.
    argv: (file) => ["run", "-A", file],
    port: 8822,
    // `_deno-target.ts` records a live Deploy deployment serving a full voice
    // session off this bundle — 74 audio frames, transcript and reply intact —
    // which is this exact path. This arm is what makes that a standing claim
    // instead of one afternoon's observation.
    acceptsSessions: true,
  },
  {
    gate: {
      bin: "bun",
      requireEnv: "AAI_REQUIRE_BUN",
      minVersion: "1.4.0",
      howTo:
        "Install Bun (`brew install oven-sh/bun/bun`, or `curl -fsSL https://bun.sh/install | bash`).\n" +
        "CI's integration-and-scenario job pins one via oven-sh/setup-bun.",
    },
    argv: (file) => [file],
    port: 8823,
    // 1.4.0 is where both of Bun's gaps close, and the table in this file's
    // header is the measurement. Below it the arms would fail on the older
    // behaviour rather than on the version, so the gate skips instead.
    minVersion: "1.4.0",
    acceptsSessions: true,
  },
];

/**
 * The deployed directory, built ONCE for the whole matrix.
 *
 * A rolldown pass over the entire runtime is ~a minute, and six arms over one
 * artifact is the point of the suite rather than an optimisation: an emit per
 * test would be six different bundles, so a difference between two runtimes
 * could be a difference between two builds.
 *
 * Copied to a SIBLING of the project, never a child, and that is the whole
 * validity of the boot arms — the Deno suite records the A/B: under
 * `<project>/deployed` the case passed with the client copy REMOVED, because
 * module resolution walks UP and found the project's own `node_modules`, so
 * the "no node_modules" claim was false.
 */
let deployedOnce: Promise<string> | undefined;

async function deployed(): Promise<string> {
  deployedOnce ??= (async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "aai_runtimes_project_"));
    await linkProjectNodeModules(project);
    await fs.mkdir(path.join(project, ".aai"), { recursive: true });
    await fs.writeFile(
      path.join(project, ".aai", "worker.mjs"),
      `export default { name: "Runtime Probe", systemPrompt: "hi", greeting: "hi", tools: {} };\n`,
    );
    await fs.writeFile(path.join(project, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
    await silenced(async (dir: string) => {
      await emitSelfContainedOutput(dir, TARGET);
    })(project);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_runtimes_deployed_"));
    await fs.cp(path.join(project, TARGET.outputDir), dir, { recursive: true });
    await fs.rm(project, { recursive: true, force: true });
    return dir;
  })();
  return await deployedOnce;
}

afterAll(async () => {
  if (deployedOnce === undefined) return;
  await fs.rm(await deployedOnce, { recursive: true, force: true });
});

/** The environment every arm boots with — a declared key, and no real credential. */
const bootEnv = (port: number): Record<string, string> => ({
  ...process.env,
  PORT: String(port),
  ASSEMBLYAI_API_KEY: "scenario-test-key",
});

/** What one boot reports back, written to a FILE rather than printed. */
interface Probe {
  readonly route: string;
  readonly status: number;
  readonly body: string;
}

/**
 * The probe driver: import the entry (which binds), then exercise the routes a
 * client actually uses, from inside the runtime under test.
 *
 * Results go to a FILE, where the Deno suite fenced them in stdout. The fence
 * was needed because the server's startup banner shares that stream, and it
 * works — but three runtimes is three flush-on-`process.exit` behaviours to
 * reason about, and a file has none of that. A driver that dies before writing
 * it is reported with its own stdout and stderr.
 */
function driverSource(outFile: string, port: number): string {
  return `import fs from "node:fs/promises";

await import("./${TARGET.entryFile}");

const base = "http://127.0.0.1:${port}";
const probes = [];
for (const route of ["/health", "/client-config", "/"]) {
  const res = await fetch(base + route);
  probes.push({ route, status: res.status, body: (await res.text()).slice(0, 400) });
}

// The session path. Deadlined rather than left to the suite's timeout: a
// runtime that accepts the upgrade and then sends nothing satisfies none of
// these listeners, and without a deadline that arrives as a timeout naming no
// assertion.
const ws = new WebSocket("ws://127.0.0.1:${port}/websocket");
const first = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ type: "no-frame" }), 20000);
  const done = (value) => {
    clearTimeout(timer);
    resolve(value);
  };
  ws.addEventListener("message", (event) => {
    done(typeof event.data === "string" ? JSON.parse(event.data) : { type: "binary" });
  });
  ws.addEventListener("close", () => done({ type: "closed" }));
  ws.addEventListener("error", () => done({ type: "error" }));
});
probes.push({
  route: "/websocket",
  status: ws.readyState === WebSocket.OPEN ? 101 : 0,
  body: JSON.stringify(first),
});

await fs.writeFile(${JSON.stringify(outFile)}, JSON.stringify(probes));
process.exit(0);
`;
}

/** Run the driver under one runtime and answer what it probed. */
async function probe(runtime: Runtime): Promise<Map<string, Probe>> {
  const dir = await deployed();
  const outFile = path.join(dir, `probes-${runtime.gate.bin}.json`);
  const driver = path.join(dir, `driver-${runtime.gate.bin}.mjs`);
  await fs.writeFile(driver, driverSource(outFile, runtime.port));

  const child = spawn(runtime.gate.bin, runtime.argv(driver), {
    cwd: dir,
    env: bootEnv(runtime.port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const exit = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  const written = await fs.readFile(outFile, "utf-8").catch(() => undefined);
  if (written === undefined) {
    throw new Error(
      `${runtime.gate.bin} wrote no probe file (exit ${String(exit)}):\n${output.slice(-4000)}`,
    );
  }
  return new Map((JSON.parse(written) as Probe[]).map((p) => [p.route, p]));
}

describe("the emitted entry's own module graph", () => {
  test("imports only `node:` builtins all three runtimes implement", async () => {
    const dir = await deployed();
    const code = await fs.readFile(path.join(dir, TARGET.entryFile), "utf-8");
    const imported = new Set(
      [...code.matchAll(/["']node:([a-z_]+(?:\/[a-z]+)?)["']/g)].map((m) => m[1] as string),
    );

    // A static gate, and the only one here that runs with no runtime
    // installed. It is what catches the class the boot arms cannot: a
    // dependency bump that drags `node:vm`, `node:cluster` or `node:v8` into
    // the deployment reaches a runtime that half-implements it as a crash at
    // the first call rather than at boot, i.e. on the first real session
    // instead of in CI.
    const allowed = [...PORTABLE_NODE_BUILTINS, ...FEATURE_DETECTED_NODE_BUILTINS];
    expect([...imported].filter((name) => !allowed.includes(name))).toEqual([]);

    // And the guard that makes the second list a different claim from the
    // first: a feature-detected builtin may be NAMED but never imported
    // statically, because a static import is a load-time dependency again —
    // which for `node:sqlite` means a deployment that dies at boot under Deno,
    // where it does not exist.
    for (const name of FEATURE_DETECTED_NODE_BUILTINS) {
      expect(code).not.toMatch(new RegExp(`from\\s*["']node:${name}["']`));
    }

    // The bundle was really read, so an unbundled or empty entry cannot pass
    // as a clean one.
    expect(imported.size).toBeGreaterThan(3);
  }, 180_000);
});

for (const runtime of RUNTIMES) {
  describeWithBinary(runtime.gate, `the emitted directory, run under ${runtime.gate.bin}`, () => {
    test("boots with no node_modules, serves the client, and accepts a session", async () => {
      const probes = await probe(runtime);

      // The worker travelled and was LOADED: the name can only come from
      // `.aai/worker.mjs`, which no bundler could have inlined.
      expect(probes.get("/health")?.status).toBe(200);
      expect(probes.get("/health")?.body).toContain("Runtime Probe");

      // What a browser reads before it dials.
      expect(probes.get("/client-config")?.status).toBe(200);
      expect(probes.get("/client-config")?.body).toContain("Runtime Probe");

      // The client is SERVED, not merely copied — `defaultClientDir()` is a
      // `require.resolve` with no `node_modules` to answer it, and a bundled
      // deployment died at boot on exactly that until the prebuilt UI was
      // copied in.
      expect(probes.get("/")?.status).toBe(200);
      expect(probes.get("/")?.body).toContain("<html");

      // The upgrade completed and the runtime configured a session on it. The
      // handshake frame is what separates a real accept from a socket that
      // opens and then dies: it arrives even though the provider key is a
      // placeholder, because configuring the session is the runtime's own
      // work. No credential is spent here.
      //
      // Branching on `acceptsSessions` rather than asserting it flat, because
      // this is the assertion a new runtime is most likely to fail — see the
      // header's table — and the branch is what makes such a runtime state its
      // answer instead of quietly not being dialled.
      expect(runtime.acceptsSessions, `${runtime.gate.bin} is declared undiallable`).toBe(true);
      expect(probes.get("/websocket")?.status).toBe(101);
      expect(probes.get("/websocket")?.body).toContain("session.configured");
    }, 180_000);

    test("closes the server on SIGTERM instead of dropping the process", async () => {
      const dir = await deployed();
      const port = runtime.port + 100;
      const child = spawn(runtime.gate.bin, runtime.argv(path.join(dir, TARGET.entryFile)), {
        cwd: dir,
        env: bootEnv(port),
        stdio: "ignore",
      });
      onTestFinished(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });

      // `vi.waitFor`, never a hand-rolled poll: a bare loop over `fetch` to a
      // closed port spins as fast as the connection is refused.
      await vi.waitFor(
        async () => {
          expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
        },
        { timeout: 60_000, interval: 100 },
      );

      // Whether a signal ARRIVES is a property of the runtime, not of the
      // drain: Deno routes `process.on("SIGTERM")` through
      // `Deno.addSignalListener`, and Bun implements the handler itself. A
      // ZERO exit is what says the server closed rather than the process being
      // killed with live sessions still open.
      const exit = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      child.kill("SIGTERM");
      expect(await exit).toBe(0);
    }, 180_000);
  });
}
