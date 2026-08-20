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

import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import { GUEST_READY_TIMEOUT_MS, raceGuestExit } from "./guest-readiness.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import {
  GUEST_PORT,
  guestOrigin,
  guestSandboxCreateParams,
  harnessCode,
  type ModalSpawnContext,
  modalContext,
} from "./modal-context.ts";
import { guestExecBaseEnv, HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { resolveSandboxRole } from "./sandbox-role.ts";
import type { WorkerSource } from "./sandbox-vm.ts";
import {
  type AgentServerHandle,
  agentBootEnv,
  agentServerFromGuest,
  type GuestFetch,
  startGuestLogging,
} from "./warm-harness.ts";

const log = createLogger("modal.agent-sandbox");

/** Where agent-mode boot artifacts land in the sandbox (written pre-exec). */
export const AGENT_BUNDLE_REMOTE_PATH = "/tmp/aai-agent-bundle.mjs";
export const AGENT_ENV_REMOTE_PATH = "/tmp/aai-agent-env.json";

/**
 * Spawn one DEPLOYED AGENT as a server in a fresh Modal sandbox: create from
 * the deploy's pinned image (falling back to current — see
 * `createGuestSandbox`), put the bundle and agent env where the guest will
 * look for them (the env always as a file; the bundle as a file only when the
 * caller holds the bytes rather than a URL — see {@link WorkerSource}),
 * exec the harness in agent mode, and wait for its public `/health` — a 200
 * means the bundle is loaded and sessions can be served. No control channel
 * is dialed; the returned handle's whole surface is HTTP + terminate.
 */
export async function spawnModalAgentServer(
  opts: {
    harnessPath: string;
    slug: string;
    /** The bundle bytes, or the URL the guest pulls them from. */
    worker: WorkerSource;
    agentEnv: Record<string, string>;
    imageTag?: string | undefined;
    /**
     * The fleet-wide sandbox NAME for this deploy (see sandbox-directory.ts).
     * Modal refuses a duplicate, which is what keeps one deploy to one sandbox
     * platform-wide with no lease table — and `createGuestSandbox` turns that
     * refusal into `SandboxNameTakenError` for every named create, so this
     * spawner needs no error handling of its own.
     */
    name: string;
    /**
     * See `BackendAgentSpawn.onSpawned` — a kill for a guest that is not ready
     * yet, published as soon as the sandbox exists.
     */
    onSpawned?: ((terminate: () => Promise<void>) => void) | undefined;
  },
  ctx?: ModalSpawnContext,
  fetchFn?: GuestFetch,
): Promise<AgentServerHandle> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const role = resolveSandboxRole({ slug: opts.slug });

  const t0 = performance.now();
  // No inner function may reference `opts`: doing so context-allocates it into
  // the scope every closure below shares, and `terminate` outlives the spawn —
  // so an inline ~8 MB worker bundle in `opts.worker` would stay reachable for
  // the sandbox's whole life. Same trap sandbox.ts documents; a `.catch` here
  // reintroduced it once. The name goes into a local for that reason.
  const sandboxName = opts.name;
  const onSpawned = opts.onSpawned;
  const sb = await context.createGuestSandbox(
    code,
    guestSandboxCreateParams({ role, slug: opts.slug, name: sandboxName }),
    opts.imageTag,
  );
  try {
    // Publish the kill the moment the sandbox EXISTS, not when it is ready:
    // from here it is scheduled and billing, and a delete arriving mid-boot
    // has to be able to end it (see BackendAgentSpawn.onSpawned for the
    // production race this closes). Inside the `try`, so a caller that throws
    // from the callback terminates the sandbox below rather than leaking it —
    // and `sb` is the only capture, which is what keeps this off the `opts`
    // trap the comment above describes.
    onSpawned?.(async () => {
      await sb.terminate();
    });
    // The tunnel lookup depends on nothing but the sandbox existing, so it
    // starts HERE rather than beside the exec below, running its round trip
    // inside the boot writes' window instead of after them. That mattered most
    // when the ~8 MB bundle write was the longest single step of a spawn; a
    // `url` source removes that write, and this is still free.
    // Contained immediately: the await is several statements away, and on
    // the write-failure path nothing ever awaits this — a rejection then must
    // not surface as unhandled.
    const tunnelsPromise = sb.tunnels();
    tunnelsPromise.catch(() => undefined);

    // Boot artifacts land on the sandbox filesystem BEFORE exec — the guest
    // reads (and hash-verifies) them at boot; nothing arrives over a channel.
    // The two writes target different paths and neither reads the other, so
    // they go together: serialized, the tiny env write paid a full round trip
    // queued behind the bundle's.
    //
    // And the BUNDLE write happens only when we hold the bytes at all. A `url`
    // source means the guest pulls it from Storage itself, which is the whole
    // point: those ~8 MB otherwise came out of Storage into this process and
    // straight back out over this write, for one cold spawn.
    await Promise.all([
      ...(opts.worker.kind === "inline"
        ? [sb.filesystem.writeText(opts.worker.code, AGENT_BUNDLE_REMOTE_PATH)]
        : []),
      sb.filesystem.writeText(JSON.stringify(opts.agentEnv), AGENT_ENV_REMOTE_PATH),
    ]);

    const token = guestTokenFor(opts.name);
    const [proc, tunnels] = await Promise.all([
      sb.exec(["node", HARNESS_REMOTE_PATH], {
        mode: "binary",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...agentBootEnv({
            slug: opts.slug,
            token,
            port: GUEST_PORT,
            bundle:
              opts.worker.kind === "url"
                ? { url: opts.worker.url }
                : { path: AGENT_BUNDLE_REMOTE_PATH },
            bundleSha256: opts.worker.sha256,
            envPath: AGENT_ENV_REMOTE_PATH,
          }),
          ...guestExecBaseEnv(),
        },
      }),
      tunnelsPromise,
    ]);
    // Before the readiness poll: a bundle that throws at load exits here, and
    // its stderr IS the diagnosis (see startGuestLogging).
    startGuestLogging(proc, `modal:${sb.sandboxId}`);
    const origin = guestOrigin(tunnels);
    // Modal's readiness probe, raced against guest-process exit: a bundle
    // that throws at load exits here, and its stderr IS the diagnosis.
    await raceGuestExit(sb.waitUntilReady(GUEST_READY_TIMEOUT_MS), proc);

    log.debug("Modal agent server spawned", {
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
    throw new SandboxUnavailableError(`Modal agent-server spawn failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}
