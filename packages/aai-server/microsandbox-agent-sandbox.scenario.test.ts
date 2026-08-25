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
 * - the platform origin doing the same, which failed as `POST /deploy 404`.
 *
 * All three were invisible to the unit suite BY CONSTRUCTION: it injects a
 * context and asserts the params the backend builds, and in every case those
 * params were correct — the defect was in what they meant to a real VM. So this
 * file's job is the part only a VM can answer, and the URL case below is the
 * regression test for the one that reached production behaviour.
 *
 * See `_microsandbox-test-utils.ts` for why this is a local tier and how
 * `AAI_REQUIRE_MICROSANDBOX=1` turns a skip into a failure.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
