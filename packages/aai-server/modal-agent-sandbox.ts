// Copyright 2026 the AAI authors. MIT license.
/**
 * Spawning one DEPLOYED AGENT as a server in a Modal sandbox — the HTTP-only
 * guest contract.
 *
 * Split from modal-sandbox.ts, which owns the shared Modal context and the
 * control-channel (studio/inspect) spawn. The two paths differ in everything
 * that matters: an agent guest gets boot artifacts written into its filesystem
 * before exec, no control channel at all, and a fleet-wide NAME so one deploy
 * has one sandbox platform-wide. The only surface the host keeps afterwards is
 * the token-gated `/manage/*` pair.
 */

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import { CONTAINED_ENV } from "@alexkroman1/aai/runtime";
import { AlreadyExistsError } from "modal";
import { debug } from "./_debug-log.ts";
import { GUEST_READY_TIMEOUT_MS, raceGuestExit } from "./guest-readiness.ts";
import { HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import {
  GUEST_PORT,
  GUEST_READINESS_PROBE,
  harnessCode,
  type ModalSpawnContext,
  modalContext,
  SandboxNameTakenError,
} from "./modal-sandbox.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  guestSandboxResources,
} from "./modal-sandbox-env.ts";
import { resolveSandboxRole, sandboxTags } from "./sandbox-role.ts";
import {
  type AgentServerHandle,
  agentBootEnv,
  agentServerFromGuest,
  type GuestFetch,
  startGuestLogging,
} from "./warm-harness.ts";

/** Where agent-mode boot artifacts land in the sandbox (written pre-exec). */
export const AGENT_BUNDLE_REMOTE_PATH = "/tmp/aai-agent-bundle.mjs";
const AGENT_ENV_REMOTE_PATH = "/tmp/aai-agent-env.json";

/**
 * Spawn one DEPLOYED AGENT as a server in a fresh Modal sandbox: create from
 * the deploy's pinned image (falling back to current — see
 * `createGuestSandbox`), write the bundle and agent env into the sandbox,
 * exec the harness in agent mode, and wait for its public `/health` — a 200
 * means the bundle is loaded and sessions can be served. No control channel
 * is dialed; the returned handle's whole surface is HTTP + terminate.
 */
export async function spawnModalAgentServer(
  opts: {
    harnessPath: string;
    slug: string;
    workerCode: string;
    workerSha256: string;
    agentEnv: Record<string, string>;
    imageTag?: string | undefined;
    /**
     * The fleet-wide sandbox NAME for this deploy (see sandbox-directory.ts).
     * Modal refuses a duplicate, which is what keeps one deploy to one
     * sandbox platform-wide with no lease table. Omitted by callers that are
     * deliberately unnamed (nothing today).
     */
    name?: string | undefined;
  },
  ctx?: ModalSpawnContext,
  fetchFn?: GuestFetch,
): Promise<AgentServerHandle> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const { limits, resourceParams } = guestSandboxResources(process.env);
  const role = resolveSandboxRole({ slug: opts.slug });

  const t0 = performance.now();
  const sb = await context
    .createGuestSandbox(
      code,
      {
        command: ["sleep", "infinity"],
        encryptedPorts: [GUEST_PORT],
        readinessProbe: GUEST_READINESS_PROBE(),
        timeoutMs: limits.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
        idleTimeoutMs: limits.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
        ...resourceParams,
        tags: sandboxTags(role, opts.slug),
        ...(opts.name && { name: opts.name }),
      },
      opts.imageTag,
    )
    .catch((err: unknown) => {
      // Lost the name race: another replica created this deploy's sandbox
      // between our directory lookup and this create. Distinguished so the
      // caller can go back to the directory instead of retrying a spawn that
      // can only lose again — this is the ONE remaining path to a duplicate,
      // and the name is what closes it.
      if (opts.name && err instanceof AlreadyExistsError) {
        throw new SandboxNameTakenError(opts.name);
      }
      throw err;
    });
  try {
    // Boot artifacts land on the sandbox filesystem BEFORE exec — the guest
    // reads (and hash-verifies) them at boot; nothing arrives over a channel.
    await sb.filesystem.writeText(opts.workerCode, AGENT_BUNDLE_REMOTE_PATH);
    await sb.filesystem.writeText(JSON.stringify(opts.agentEnv), AGENT_ENV_REMOTE_PATH);

    const token = randomBytes(32).toString("hex");
    const [proc, tunnels] = await Promise.all([
      sb.exec(["node", HARNESS_REMOTE_PATH], {
        mode: "binary",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...agentBootEnv({
            token,
            port: GUEST_PORT,
            bundlePath: AGENT_BUNDLE_REMOTE_PATH,
            bundleSha256: opts.workerSha256,
            envPath: AGENT_ENV_REMOTE_PATH,
          }),
          [CONTAINED_ENV]: "1",
        },
      }),
      sb.tunnels(),
    ]);
    // Before the readiness poll: a bundle that throws at load exits here, and
    // its stderr IS the diagnosis (see startGuestLogging).
    startGuestLogging(proc, `modal:${sb.sandboxId}`);
    const tunnel = tunnels[GUEST_PORT];
    if (!tunnel) {
      throw new Error(`no tunnel for guest port ${GUEST_PORT}`);
    }
    const origin = `wss://${tunnel.host}:${tunnel.port}`;
    // Modal's readiness probe, raced against guest-process exit: a bundle
    // that throws at load exits here, and its stderr IS the diagnosis.
    await raceGuestExit(sb.waitUntilReady(GUEST_READY_TIMEOUT_MS), proc);

    debug("Modal agent server spawned", {
      sandboxId: sb.sandboxId,
      slug: opts.slug,
      ms: Math.round(performance.now() - t0),
    });

    return agentServerFromGuest({
      proc,
      terminate: () => sb.terminate(),
      origin,
      token,
      fetchFn,
    });
  } catch (err) {
    // Never leak a sandbox whose agent server failed to come up.
    await sb.terminate().catch(() => undefined);
    throw new Error(`Modal agent-server spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}
