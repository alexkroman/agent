// Copyright 2026 the AAI authors. MIT license.
/**
 * Integration: studio Publish end to end — a REAL harness process runs the
 * LITERAL `aai deploy` CLI (`workspace/deploy`) against a REAL listening
 * platform orchestrator. The CLI resolves from the toolchain node_modules
 * next to the harness, builds the workspace (runtime-shipping worker), and
 * uploads through the standard `POST /deploy` route — the exact laptop
 * path, which is the point: studio publishes and CLI deploys are one
 * constantly-exercised pass, and the CLI's output is what the chat shows.
 *
 * The harness is spawned directly as a child process — test scaffolding,
 * not a sandbox backend: isolation is irrelevant here (the workspace is
 * ours), and it keeps this covered on any CI runner. Running from
 * `packages/aai-guest/dist/harness.mjs` is also exactly the resolution
 * shape production has: the toolchain resolves by walking up from the
 * harness file (aai-guest's node_modules here, the baked `/opt/aai`
 * node_modules on Modal).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { createTestStore } from "./test-utils.ts";
import { dialGuest, getFreePort, startGuestLogging, warmFromGuest } from "./warm-harness.ts";

const AGENT_TS = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "integration-publish",
  systemPrompt: "You are a test agent.",
  greeting: "Hello.",
});
`;

type DeployResult = {
  ok: boolean;
  slug?: string;
  url?: string;
  output: string;
};

/** Spawn a real harness child process and dial its control channel. */
async function spawnTestHarness(): Promise<WarmHarness> {
  const port = await getFreePort();
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [resolveHarnessPath()], {
    env: {
      AAI_GUEST_TOKEN: token,
      AAI_GUEST_PORT: String(port),
      AAI_GUEST_HOST: "127.0.0.1",
      ...omitUndefined({ PATH: process.env.PATH }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const wait = new Promise<number>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (code) => resolve(code ?? -1));
  });
  const proc = {
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    wait: () => wait,
  };
  const terminate = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  try {
    // Mirrors the backends: log the guest's stdio from the moment it exists,
    // so a harness that dies before the dial still explains itself.
    startGuestLogging(proc, `test-harness:${port}`);
    const ws = await dialGuest(`ws://127.0.0.1:${port}/ws`, token);
    return warmFromGuest({
      proc,
      terminate,
      ws,
      origin: `ws://127.0.0.1:${port}`,
      token,
    });
  } catch (err) {
    await terminate();
    throw err;
  }
}

describe("guest workspace/deploy (Publish = aai deploy in the sandbox)", () => {
  const store = createTestStore();
  let server: ServerType;
  let serverUrl: string;

  beforeAll(async () => {
    // A real listening platform: the guest's CLI dials it over HTTP exactly as
    // a laptop would, through the standard `POST /deploy` route. Nothing is
    // injected past the slot cache and the store — the `inspect` hook this
    // comment used to describe no longer exists.
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) =>
        resolve(info.port),
      );
    });
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    // AWAITED: `close()` returns before the listening socket is released, so
    // an un-awaited teardown leaks a bound port past the end of the file —
    // which on a runner with a small ephemeral range is the next suite's
    // EADDRINUSE, reported against the wrong test.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function deployInGuest(files: Record<string, string>): Promise<DeployResult> {
    // `await using`: the harness is a real sandbox, so a leaked one on a failing
    // assertion outlives the suite. Scope exit runs the same teardown the
    // hand-written `finally` did, on every path including the ones a later
    // early-return adds.
    await using warm = await spawnTestHarness();
    warm.conn.listen();
    return (await warm.conn.sendRequest(
      "workspace/deploy",
      { files, serverUrl, apiKey: "integration-test-key", slug: "integration-publish" },
      300_000,
    )) as DeployResult;
  }

  test("publishes a workspace through the literal CLI", { timeout: 300_000 }, async () => {
    const result = await deployInGuest({ "agent.ts": AGENT_TS });

    expect(result.ok).toBe(true);
    expect(result.slug).toBe("integration-publish");
    expect(result.output).toContain("Deployed");
    // The standard POST /deploy path stored the bundle: a runtime-shipping
    // worker under the requested slug, with the caller's key seeded as the
    // agent's ASSEMBLYAI_API_KEY (the CLI's env floor).
    const worker = await store.getWorkerCode("integration-publish");
    expect(worker).toContain("__aaiCreateRuntime");
    expect(await store.getEnv("integration-publish")).toMatchObject({
      ASSEMBLYAI_API_KEY: "integration-test-key",
    });
  });

  test("compile errors come back as CLI output for the chat", { timeout: 300_000 }, async () => {
    // The guest completes the workspace into a real project (tsconfig
    // included), so `aai deploy`'s typecheck gate reports this before the
    // bundler would — either way, diagnostics the coding agent can act on.
    const result = await deployInGuest({ "agent.ts": "const nope = {" });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Type check failed|Build failed/);
    expect(result.output).toContain("agent.ts");
  });
});
