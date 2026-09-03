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

import pTimeout from "p-timeout";
import { afterAll, describe, expect, test, vi } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { spawnSubprocessAgentServer } from "./subprocess-sandbox.ts";
import { captureLogs } from "./test-utils.ts";
import type { AgentServerHandle } from "./warm-harness.ts";
import { GUEST_PROXY_TOKEN_HEADER } from "./workflow-proxy-constants.ts";

/**
 * How long the drain spec waits for the guest to notice and exit — many
 * lifecycle polls (`AGENT_IDLE_POLL_MS`, 5s in aai-guest/limits.ts), so a slow
 * CI box is not a failure, while a guest that never exits reports the broken
 * drain instead of the suite's 60s ceiling.
 */
const DRAIN_EXIT_BUDGET_MS = 30_000;

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
    name: "agent-integration-v1",
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
  const logs = captureLogs();
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

  test("the workflow API refuses a DIRECT tunnel dial, but not the platform's", async () => {
    // The finding this fixes: `/client-config` hands the sandbox tunnel URL to
    // browsers, so anyone could dial `/workflows` straight on the tunnel and skip
    // the platform's per-IP run limiters. The guest now requires the manage bearer
    // in GUEST_PROXY_TOKEN_HEADER — which only the platform's proxy injects.
    const handle = await spawnAgent();
    const origin = handle.sessionUrl.replace("/websocket", "");
    const workflowsUrl = guestHttpUrl(origin, GUEST_ROUTES.workflows);
    // The subprocess backend derives AAI_GUEST_TOKEN the same way the platform
    // does, from the sandbox name spawnAgent passed.
    const proxyToken = guestTokenFor("agent-integration-v1");

    // A direct dial (no proxy header) is refused before it reaches the runtime.
    const direct = await fetch(workflowsUrl);
    expect(direct.status).toBe(401);

    // A forged token is refused too.
    const forged = await fetch(workflowsUrl, {
      headers: { [GUEST_PROXY_TOKEN_HEADER]: "not-the-token" },
    });
    expect(forged.status).toBe(401);

    // With the real bearer the gate falls through to the runtime's own workflow
    // API, which for this inert bundle (no workflows) answers 404 — i.e. NOT the
    // gate's 401, proving a platform-proxied request is served.
    const proxied = await fetch(workflowsUrl, {
      headers: { [GUEST_PROXY_TOKEN_HEADER]: proxyToken },
    });
    expect(proxied.status).toBe(404);
    expect(proxied.status).not.toBe(401);
  }, 60_000);

  test("drain flips the guest to draining and it self-exits when empty", async () => {
    const handle = await spawnAgent();
    // Registered BEFORE the drain: `onExit` is one-shot and fires immediately
    // when the guest is already dead, so there is no window to miss.
    const exited = Promise.withResolvers<void>();
    handle.onExit(() => exited.resolve());

    await handle.drain();

    // Draining with zero sessions: the guest exits on its next lifecycle
    // poll (AGENT_IDLE_POLL_MS), which the host observes as process exit.
    // BOUNDED — a bare `await` on the exit promise let a guest that stopped
    // self-exiting hang to the file's 60s budget and then blame the timeout
    // rather than naming the broken drain.
    await pTimeout(exited.promise, {
      milliseconds: DRAIN_EXIT_BUDGET_MS,
      message:
        `the guest did not exit within ${DRAIN_EXIT_BUDGET_MS}ms of drain() — ` +
        "drain-then-self-exit is broken",
    });
    expect(handle.alive()).toBe(false);
  }, 60_000);

  test("a bundle hash mismatch is a hard boot failure, not a silent agent", async () => {
    // The HOST's error is the wrapper every spawn failure carries
    // (`Subprocess agent-server spawn failed: guest exited before ready …`), so
    // `/not ready|spawn failed/i` matched a bad harness path just as happily.
    // The guest's own refusal is what discriminates, and it reaches the host on
    // the stderr `startGuestLogging` relays through the `guest` logger.
    await expect(spawnAgent({ workerSha256: "0".repeat(64) })).rejects.toThrow(
      SandboxUnavailableError,
    );
    // The relay is a stream drain racing the spawn's rejection, so the line can
    // land a tick late.
    await vi.waitFor(() => {
      expect(logs.warns().join("\n")).toMatch(
        new RegExp(`bundle hash mismatch: expected sha256 ${"0".repeat(64)}`),
      );
    });
  }, 60_000);
});
