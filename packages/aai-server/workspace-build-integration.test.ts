// Copyright 2026 the AAI authors. MIT license.
/**
 * Integration: the guest's `workspace/build` — a REAL harness process
 * building a workspace through the aai CLI's own bundlers (the toolchain
 * resolved from the node_modules next to the harness) and loading the
 * built worker in place for its config self-description.
 *
 * This is THE studio build path (there is no host-side build anymore), so
 * this test is what keeps "studio builds" and "aai deploy builds" one
 * constantly-exercised pass.
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
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { dialGuest, getFreePort, warmFromGuest } from "./warm-harness.ts";

const AGENT_TS = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "integration-build",
  systemPrompt: "You are a test agent.",
  greeting: "Hello.",
});
`;

type BuildResult = {
  worker?: string;
  clientFiles?: Record<string, string>;
  config?: unknown;
  buildError?: string;
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

async function buildInGuest(files: Record<string, string>, client: boolean): Promise<BuildResult> {
  const warm = await spawnTestHarness();
  try {
    registerGuestRpcHandlers(warm.conn, {});
    warm.conn.listen();
    return (await warm.conn.sendRequest(
      "workspace/build",
      { files, worker: true, client },
      240_000,
    )) as BuildResult;
  } finally {
    await warm[Symbol.asyncDispose]();
  }
}

describe("guest workspace/build", () => {
  test("builds a workspace in the guest and self-describes the config", {
    timeout: 300_000,
  }, async () => {
    const result = await buildInGuest({ "agent.ts": AGENT_TS }, true);

    expect(result.buildError).toBeUndefined();
    // The worker ships its own runtime — the factory export is present.
    expect(result.worker).toContain("__aaiCreateRuntime");
    // No client.tsx → no client files → published agents get the default UI.
    expect(result.clientFiles).toEqual({});
    // Loaded in place: the config the host's Publish validates rode back.
    expect(result.config).toMatchObject({
      name: "integration-build",
      greeting: "Hello.",
    });
  });

  test("reports compile errors as buildError prose (agent-actionable)", {
    timeout: 300_000,
  }, async () => {
    const result = await buildInGuest({ "agent.ts": "const nope = {" }, false);
    expect(result.worker).toBeUndefined();
    expect(result.buildError).toContain("Build failed");
  });
});
