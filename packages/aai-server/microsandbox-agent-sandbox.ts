// Copyright 2026 the AAI authors. MIT license.
/**
 * Spawning one DEPLOYED AGENT as a server in a microVM — the HTTP-only guest
 * contract.
 *
 * Split from `microsandbox-sandbox.ts` the way `modal-agent-sandbox.ts` is split
 * from `modal-sandbox.ts`, and for the same reason: the two paths differ in
 * everything that matters. An agent guest gets boot artifacts written into its
 * filesystem before the exec, no control channel at all, and a fleet-wide NAME
 * so one deploy has one sandbox. The only surface the host keeps afterwards is
 * the token-gated `/manage/*` pair.
 *
 * What it shares with the warm path — the image reference, the VM's resources,
 * the loopback rewrite, the injectable context — comes from that module, so the
 * two cannot drift on how a guest is BUILT while differing on what is done
 * with it.
 */

import { access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import { pollGuestHealth } from "./guest-readiness.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import { rewriteLoopbackForGuest } from "./microsandbox-network.ts";
import {
  DEFAULT_GUEST_CPUS,
  DEFAULT_GUEST_MEMORY_MIB,
  defaultMicrosandboxContext,
  guestBuildEnv,
  type MicrosandboxSpawnContext,
  microsandboxImageRef,
} from "./microsandbox-sandbox.ts";
import { AGENT_BUNDLE_REMOTE_PATH, AGENT_ENV_REMOTE_PATH } from "./modal-agent-sandbox.ts";
import { GUEST_PORT, harnessCode } from "./modal-context.ts";
import { guestExecBaseEnv, HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import { parseSandboxLimitsFromEnv } from "./modal-sandbox-env.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import type { WorkerSource } from "./sandbox-vm.ts";
import {
  type AgentServerHandle,
  agentBootEnv,
  agentServerFromGuest,
  type GuestFetch,
  getFreePort,
  startGuestLogging,
} from "./warm-harness.ts";

const log = createLogger("sandbox.microsandbox.agent");

// ── Agent-server spawning (the HTTP-only contract) ───────────────────────────

/**
 * Spawn one DEPLOYED AGENT as a server in a microVM: write the bundle and env
 * where the guest looks for them, exec the harness in agent mode, and wait for
 * `/health`. No control channel; the handle is HTTP plus terminate.
 */
export async function spawnMicrosandboxAgentServer(
  opts: {
    harnessPath: string;
    slug: string;
    name: string;
    worker: WorkerSource;
    agentEnv: Record<string, string>;
    onSpawned?: ((terminate: () => Promise<void>) => void) | undefined;
  },
  ctx: MicrosandboxSpawnContext = defaultMicrosandboxContext(),
  fetchFn?: GuestFetch,
): Promise<AgentServerHandle> {
  const t0 = performance.now();
  try {
    await access(opts.harnessPath);
    const hostPort = await getFreePort();
    const limits = parseSandboxLimitsFromEnv(process.env);
    const token = guestTokenFor(opts.name);

    // The agent's own env is where the loopback DSNs live. Rewriting it is what
    // makes ctx.db, storage and durable workflows work at all in a VM, and the
    // ports it reports are exactly what the network policy opens.
    const { env: agentEnv, hostPorts: envPorts } = rewriteLoopbackForGuest(opts.agentEnv);

    // The BUNDLE URL needs the same treatment, and it does not travel in that
    // env — it rides the boot env as `AAI_BUNDLE_URL`. A dev platform database
    // signs a Storage URL on the host's own loopback, so an unrewritten one is a
    // guest fetching itself: `agent-mode boot failed: bundle fetch failed`.
    // `subprocess` never saw it (its guest shares the host's stack) and Modal
    // never sees it (the signed URL is a real public one).
    const worker =
      opts.worker.kind === "url"
        ? rewriteLoopbackForGuest({ url: opts.worker.url })
        : { env: {}, hostPorts: [] };
    const bundleUrl = worker.env.url;

    const boot = agentBootEnv({
      slug: opts.slug,
      token,
      port: GUEST_PORT,
      bundle: bundleUrl === undefined ? { path: AGENT_BUNDLE_REMOTE_PATH } : { url: bundleUrl },
      bundleSha256: opts.worker.sha256,
      envPath: AGENT_ENV_REMOTE_PATH,
    });

    // And `AAI_UPLOAD_BROKER_URL` is the THIRD URL in this boot env the guest
    // DIALS: `writeUpload` PUTs every byte window to
    // `<broker>/uploads/<id>/<offset>`. Its twin `AAI_PUBLIC_BASE_URL` carries
    // the SAME value and is deliberately NOT rewritten — that one is what a
    // third party is handed (`ctx.workflows.publicWebhookUrl`), so the alias
    // would be unreachable for precisely the caller it exists for. Same value,
    // opposite requirement; `agentBootEnv` argues why one key cannot serve both.
    //
    // Unrewritten, this pointed at the guest's own harness, which serves no
    // `/uploads` route — so EVERY workflow upload failed, and failed slowly: a
    // guest dialing itself hangs out `BYTE_OP_TIMEOUT_MS` (120s) per byte op
    // rather than refusing. The port comes along with the rewrite, which is
    // what opens the platform's own port for an agent guest at all — the studio
    // spawner adds `platformHostPort()` by hand because a warm guest holds no
    // DSN to derive one from; here the derivation covers it.
    const broker =
      boot.AAI_UPLOAD_BROKER_URL === undefined
        ? { env: {}, hostPorts: [] }
        : rewriteLoopbackForGuest({ AAI_UPLOAD_BROKER_URL: boot.AAI_UPLOAD_BROKER_URL });

    // One port set for the policy, from every value that was rewritten.
    const hostPorts = [...new Set([...envPorts, ...worker.hostPorts, ...broker.hostPorts])].sort(
      (a, b) => a - b,
    );

    const sandbox = await ctx.createSandbox({
      imageRef: microsandboxImageRef(await harnessCode(opts.harnessPath)),
      name: opts.name,
      hostPort,
      env: {
        ...guestExecBaseEnv(),
        ...guestBuildEnv(),
        ...boot,
        ...broker.env,
      },
      hostPorts,
      memoryLimitMiB: limits.memoryLimitMiB ?? DEFAULT_GUEST_MEMORY_MIB,
      cpus: limits.cpuLimit ?? DEFAULT_GUEST_CPUS,
      labels: { role: "agent", slug: opts.slug },
    });

    const terminate = async (): Promise<void> => {
      await sandbox.stop().catch(() => undefined);
    };
    // Published before readiness, for the reason BackendAgentSpawn.onSpawned
    // carries: a guest that is still starting must still be killable.
    opts.onSpawned?.(terminate);

    try {
      if (opts.worker.kind === "inline") {
        await sandbox.writeFile(AGENT_BUNDLE_REMOTE_PATH, opts.worker.code);
      }
      await sandbox.writeFile(AGENT_ENV_REMOTE_PATH, JSON.stringify(agentEnv));

      const proc = await sandbox.exec(["node", HARNESS_REMOTE_PATH]);
      // Before the readiness poll: a bundle that throws at load exits here, and
      // its stderr IS the diagnosis.
      startGuestLogging(proc, `microsandbox:${hostPort}`);
      const origin = `ws://127.0.0.1:${hostPort}`;
      await pollGuestHealth(origin, proc, fetchFn);
      log.debug("Microsandbox agent server spawned", {
        slug: opts.slug,
        hostPort,
        ms: Math.round(performance.now() - t0),
      });
      return agentServerFromGuest({ proc, terminate, origin, token, fetchFn });
    } catch (err) {
      await terminate();
      throw err;
    }
  } catch (err) {
    throw new SandboxUnavailableError(
      `Microsandbox agent-server spawn failed: ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

/** @internal Exposed for unit tests only. */
