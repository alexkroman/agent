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
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createMemoryChatStore } from "./chat-store.ts";
import { resolveHarnessPath } from "./constants.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { createTestStore, TEST_AGENT_CONFIG } from "./test-utils.ts";
import { dialGuest, getFreePort, warmFromGuest } from "./warm-harness.ts";
import { createMemoryWorkspaceStore } from "./workspace-store.ts";

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
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
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
    const ws = await dialGuest(`ws://127.0.0.1:${port}/ws`, token);
    return warmFromGuest({
      label: `test-harness:${port}`,
      proc,
      terminate,
      ws,
      sessionUrl: `ws://127.0.0.1:${port}/websocket`,
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
    // A real listening platform: the guest's CLI dials it over HTTP exactly
    // as a laptop would. `inspect` is injected (the real default would spawn
    // a Modal sandbox to read the worker's self-description).
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
      workspaces: createMemoryWorkspaceStore(),
      chats: createMemoryChatStore(),
      inspect: async () => TEST_AGENT_CONFIG,
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) =>
        resolve(info.port),
      );
    });
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function deployInGuest(files: Record<string, string>): Promise<DeployResult> {
    const warm = await spawnTestHarness();
    try {
      registerGuestRpcHandlers(warm.conn, {});
      warm.conn.listen();
      return (await warm.conn.sendRequest(
        "workspace/deploy",
        { files, serverUrl, apiKey: "integration-test-key", slug: "integration-publish" },
        300_000,
      )) as DeployResult;
    } finally {
      await warm[Symbol.asyncDispose]();
    }
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
    const result = await deployInGuest({ "agent.ts": "const nope = {" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Build failed");
  });
});
