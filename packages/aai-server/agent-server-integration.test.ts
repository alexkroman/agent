// Copyright 2026 the AAI authors. MIT license.
/**
 * Integration: the AGENT-SERVER contract end to end — a REAL harness process
 * booted in agent mode through `spawnSubprocessAgentServer`: bundle + env
 * delivered as files, hash verified in the guest, readiness via `/health`,
 * the token-gated `/manage/*` surface, drain semantics, and self-teardown.
 *
 * This is the whole surviving platform↔deployed-agent surface, exercised
 * with no mocks: what breaks here breaks deployed agents.
 */

import { afterAll, describe, expect, test } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { describeSubprocessBundle, spawnSubprocessAgentServer } from "./subprocess-sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// A minimal but REAL bundle: the harness contract demands the
// __aaiCreateRuntime factory; the inert runtime is all agent-mode boot needs.
const WORKER_CODE = `
export const __aaiConfig = { name: "server-mode-agent" };
export const __aaiCreateRuntime = (opts) => ({
  startSession: () => undefined,
  shutdown: () => Promise.resolve(),
});
export default { name: "server-mode-agent", systemPrompt: "p", greeting: "g", tools: {} };
`;

const sha256 = async (text: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf-8").digest("hex");
};

const handles: AgentServerHandle[] = [];

async function spawnAgent(overrides: { workerSha256?: string } = {}): Promise<AgentServerHandle> {
  const handle = await spawnSubprocessAgentServer({
    harnessPath: resolveHarnessPath(),
    slug: "server-mode-agent",
    worker: {
      kind: "inline",
      code: WORKER_CODE,
      sha256: overrides.workerSha256 ?? (await sha256(WORKER_CODE)),
    },
    agentEnv: { SOME_KEY: "some-value" },
  });
  handles.push(handle);
  return handle;
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.shutdown().catch(() => undefined)));
});

describe("agent-server contract (real harness, no mocks)", () => {
  test("boots from files, answers health, serves the manage surface", async () => {
    const handle = await spawnAgent();

    // spawn resolved ⇒ /health already answered 200 with the bundle loaded.
    expect(handle.alive()).toBe(true);
    expect(handle.sessionUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/websocket$/);

    // The status probe idle eviction and retirement rely on.
    await expect(handle.activeSessions()).resolves.toBe(0);
  }, 60_000);

  test("the manage surface rejects a missing or wrong bearer", async () => {
    const handle = await spawnAgent();
    const origin = handle.sessionUrl.replace("/websocket", "");
    const statusUrl = guestHttpUrl(origin, GUEST_ROUTES.manageStatus);

    // The guest is the client-config authority (the platform broker
    // proxies this): the bundle's own name reaches the public surface.
    const cfg = await fetch(guestHttpUrl(origin, GUEST_ROUTES.clientConfig));
    expect(cfg.status).toBe(200);
    expect(await cfg.json()).toMatchObject({ name: "server-mode-agent" });

    const noAuth = await fetch(statusUrl);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(statusUrl, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrongAuth.status).toBe(401);

    // Public surfaces stay public.
    const health = await fetch(guestHttpUrl(origin, GUEST_ROUTES.health));
    expect(health.status).toBe(200);
  }, 60_000);

  test("drain flips the guest to draining and it self-exits when empty", async () => {
    const handle = await spawnAgent();
    await handle.drain();

    // Draining with zero sessions: the guest exits on its next lifecycle
    // poll (AGENT_IDLE_POLL_MS), which the host observes as process exit.
    await new Promise<void>((resolve) => {
      handle.onExit(resolve);
    });
    expect(handle.alive()).toBe(false);
  }, 60_000);

  test("a bundle hash mismatch is a hard boot failure, not a silent agent", async () => {
    await expect(spawnAgent({ workerSha256: "0".repeat(64) })).rejects.toThrow(
      /not ready|spawn failed/i,
    );
  }, 60_000);
});

describe("describe mode (real harness one-shot exec)", () => {
  test("extracts the bundle's self-described config from stdout", async () => {
    const config = await describeSubprocessBundle({
      harnessPath: resolveHarnessPath(),
      // Top-level stdout noise must not corrupt the result (last-line rule).
      workerCode: `console.log("bundle top-level noise");\n${WORKER_CODE}`,
    });
    expect(config).toEqual({ name: "server-mode-agent" });
  }, 60_000);

  test("a broken bundle fails the describe with the load error", async () => {
    await expect(
      describeSubprocessBundle({
        harnessPath: resolveHarnessPath(),
        workerCode: "throw new Error('top-level boom')",
      }),
    ).rejects.toThrow(/top-level boom/);
  }, 60_000);
});
