// Copyright 2026 the AAI authors. MIT license.
/**
 * A DEPLOYED AGENT in a real microVM.
 *
 * The warm/studio scenario suite covers a guest that is handed nothing: no
 * bundle, no tenant env, no host dependency. Every bug this backend has actually
 * shipped was on the OTHER path — the one that writes boot artifacts, rewrites a
 * tenant env for the VM's network namespace, and fetches its own bundle:
 *
 * - the agent env's loopback DSNs pointing at the VM instead of the host,
 * - the bundle URL doing the same, which failed as `agent-mode boot failed:
 *   bundle fetch failed` — a guest fetching itself,
 * - the platform origin doing the same, which failed as `POST /deploy 404`,
 * - and the platform origin AGAIN, one key over: `AAI_PUBLIC_BASE_URL` was also
 *   the base the guest DIALED for run storage, the queue, session state and
 *   upload records, and it must not be rewritten (it is what a third party is
 *   handed). So every platform call went to the guest itself — `POST
 *   /<slug>/workflow-storage 404`, from its own 404 handler — and every durable
 *   run in a studio preview died at its first `events.create`.
 *
 * The first three were invisible to the unit suite BY CONSTRUCTION: it injects a
 * context and asserts the params the backend builds, and in each case those
 * params were correct — the defect was in what they meant to a real VM. **The
 * fourth was not**: the param itself was wrong, so its primary regression test is
 * a unit one, which matters because `AAI_REQUIRE_MICROSANDBOX` is exported by
 * nothing and this tier has never gated a merge. It is ALSO tested here, because
 * only a VM can answer whether the value the guest ends up holding is reachable —
 * and that is the claim, not the string.
 *
 * See `_microsandbox-test-utils.ts` for why this is a local tier and how
 * `AAI_REQUIRE_MICROSANDBOX=1` turns a skip into a failure.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { microsandboxGate, probeMicrosandbox } from "./_microsandbox-test-utils.ts";
import { resolveHarnessPath } from "./constants.ts";
import { spawnMicrosandboxAgentServer } from "./microsandbox-agent-sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// Top level, never inside the gated `describe` body — see probeMicrosandbox.
const gate = microsandboxGate(await probeMicrosandbox());
if (gate.skip) console.warn(`microsandbox agent scenario tier SKIPPED — ${gate.reason}`);
const scenario = gate.skip ? describe.skip : describe;

/**
 * A minimal but REAL bundle: the harness contract demands the
 * `__aaiCreateRuntime` factory, and an inert runtime is all agent-mode boot
 * needs. Same shape as `agent-server-integration.test.ts`.
 */
const WORKER_CODE = `
export const __aaiConfig = { name: "microvm-agent" };
export const __aaiCreateRuntime = () => ({
  startSession: () => undefined,
  shutdown: () => Promise.resolve(),
});
export default { name: "microvm-agent", systemPrompt: "p", greeting: "g", tools: {} };
`;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

const handles: AgentServerHandle[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.shutdown().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Serve the bundle from the HOST, on an ephemeral loopback port. */
async function serveBundle(code: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(code);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/worker.mjs`;
}

/**
 * Stand in for the PLATFORM on the host, recording the paths it is asked for.
 *
 * It answers 500 deliberately: the assertion is which HOST received the request,
 * not that a storage call succeeded — a fake with protocol fidelity would be
 * testing the DevKit. Arriving here at all is the proof, because the failure this
 * covers is the guest answering its OWN request, in which case nothing arrives.
 */
async function recordingPlatform(): Promise<{ origin: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"scenario stub"}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, paths };
}

/**
 * A bundle that DIALS the platform base out of its own `process.env`, which is
 * precisely what `resolvePlatformQueue` does one layer up.
 *
 * Reaching for the env directly rather than starting a durable run keeps the
 * DevKit out of it: a real run would need compiled workflow artifacts, and what
 * is under test is whether the URL the guest holds resolves to the HOST. Fire and
 * forget, so a boot the harness must still complete is not waiting on it.
 */
const DIALING_WORKER_CODE = `
export const __aaiConfig = { name: "microvm-agent" };
export const __aaiCreateRuntime = () => ({
  startSession: () => undefined,
  shutdown: () => Promise.resolve(),
});
void fetch(process.env.AAI_PLATFORM_BASE_URL + "/workflow-storage", {
  method: "POST",
  body: JSON.stringify({ method: "runs.list", args: [] }),
}).catch(() => undefined);
export default { name: "microvm-agent", systemPrompt: "p", greeting: "g", tools: {} };
`;

scenario("spawnMicrosandboxAgentServer against a real microVM", () => {
  it("boots an inline bundle and answers its manage surface", async () => {
    // The spawner's promise only resolves after `/health` returns, and agent
    // mode listens ONLY after hash-verifying and loading the bundle — so
    // resolving at all means the bundle really loaded inside the VM.
    const handle = await spawnMicrosandboxAgentServer({
      harnessPath: resolveHarnessPath(),
      slug: "microvm-agent",
      name: `scenario-agent-inline-${process.pid}`,
      worker: { kind: "inline", code: WORKER_CODE, sha256: sha256(WORKER_CODE) },
      agentEnv: { SOME_KEY: "some-value" },
    });
    handles.push(handle);

    expect(handle.guestOrigin).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.alive()).toBe(true);
    // The whole ongoing host surface for an agent guest is the token-gated
    // manage pair; a number back means the token and the route both work.
    await expect(handle.activeSessions()).resolves.toBeTypeOf("number");
  });

  it("fetches a bundle from a LOOPBACK url on the host", async () => {
    // The regression test. Unrewritten, `http://127.0.0.1:<port>` inside a VM is
    // the VM, and the guest fails with `bundle fetch failed` — which is exactly
    // how this shipped. Passing proves both halves: the URL was rewritten to the
    // host alias, AND the network policy opened the port that rewrite named.
    const url = await serveBundle(WORKER_CODE);
    const handle = await spawnMicrosandboxAgentServer({
      harnessPath: resolveHarnessPath(),
      slug: "microvm-agent",
      name: `scenario-agent-url-${process.pid}`,
      worker: { kind: "url", url, sha256: sha256(WORKER_CODE) },
      agentEnv: {},
    });
    handles.push(handle);

    expect(handle.alive()).toBe(true);
  });

  it("dials the PLATFORM base on the host, not its own harness", async () => {
    // The regression, end to end in a real VM. `AAI_PUBLIC_BASE_URL` and the
    // platform's own port are both loopback:8080, and GUEST_PORT is 8080 too —
    // so before the split the guest POSTed every platform call to ITSELF and its
    // own 404 handler answered, which is what a studio preview reported as
    // `storage runs.list answered HTTP 404: {"error":"Not found"}`. Nothing
    // reached the host, which is exactly what this asserts against.
    const platform = await recordingPlatform();
    vi.stubEnv("AAI_PUBLIC_ORIGIN", platform.origin);
    const handle = await spawnMicrosandboxAgentServer({
      harnessPath: resolveHarnessPath(),
      slug: "microvm-agent",
      name: `scenario-agent-dial-${process.pid}`,
      worker: {
        kind: "inline",
        code: DIALING_WORKER_CODE,
        sha256: sha256(DIALING_WORKER_CODE),
      },
      agentEnv: {},
    });
    handles.push(handle);

    // The host saw it, so the alias resolved AND the policy opened the port the
    // rewrite named. A 404 from the guest to itself would leave this empty.
    await vi.waitFor(() => {
      expect(platform.paths).toContain("/microvm-agent/workflow-storage");
    });
  });

  it("refuses a bundle whose hash does not match", async () => {
    // The delivery path is trusted in neither shape, so a wrong hash must fail
    // the BOOT rather than load anyway — and that check runs in the guest.
    await expect(
      spawnMicrosandboxAgentServer({
        harnessPath: resolveHarnessPath(),
        slug: "microvm-agent",
        name: `scenario-agent-badhash-${process.pid}`,
        worker: { kind: "inline", code: WORKER_CODE, sha256: sha256("something else") },
        agentEnv: {},
      }),
    ).rejects.toThrow(/Microsandbox agent-server spawn failed/);
  });
});
