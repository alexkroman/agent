// Copyright 2026 the AAI authors. MIT license.
/**
 * Modal-backed sandbox spawning — the CONTROL-CHANNEL guest (studio, inspect).
 *
 * Every guest harness runs in a [Modal Sandbox](https://modal.com/docs/guide/sandbox)
 * — a remote, isolated container managed by Modal's infrastructure. The
 * sandbox is created from a snapshot image with the harness baked in (built
 * once per harness version — see modal-context.ts), the harness is exec'd as a
 * Node process serving a WebSocket, and the host dials that socket through
 * the sandbox's Modal tunnel. JSON-RPC 2.0 messages flow both ways over the
 * socket (see rpc-transport.ts).
 *
 * The shared Modal context (client, App, snapshot image, harness bytes) lives
 * in modal-context.ts; the deployed-agent spawn — no control channel, boot
 * artifacts written before exec — is modal-agent-sandbox.ts.
 *
 * Security properties:
 * - **The tunnel is public but the harness is not**: the host mints a
 *   per-sandbox bearer token, delivers it via the exec's env (never the
 *   sandbox's), and the harness rejects unauthenticated upgrades.
 * - **No secrets in the SANDBOX environment**: per-sandbox tokens ride the
 *   EXEC env (they die with the process), and a deployed agent's own env
 *   arrives as a file written into its sandbox and scrubbed after boot —
 *   studio sandboxes receive per-session data over the control channel.
 * - **No host filesystem**: the sandbox sees only the baked guest image.
 * - **Resource limits**: memory/CPU caps map onto Modal's per-sandbox
 *   `memoryLimitMiB`/`cpuLimit` options.
 *
 * Guest runtime is Node — the same runtime as the host and `aai dev`, so
 * tool code behaves identically everywhere. The Modal sandbox (not a
 * language runtime permission model) is the security boundary.
 */

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import { GUEST_READY_TIMEOUT_MS, raceGuestExit } from "./guest-readiness.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { createLogger } from "./logger.ts";
import {
  GUEST_PORT,
  guestOrigin,
  guestSandboxCreateParams,
  harnessCode,
  type ModalProcLike,
  type ModalSandboxLike,
  type ModalSpawnContext,
  modalContext,
  resetModalContext,
} from "./modal-context.ts";
import { guestExecBaseEnv, HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import type { RpcWebSocket } from "./rpc-transport.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { resolveSandboxRole, type SpawnIdentity } from "./sandbox-role.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { type DialGuest, dialGuest, startGuestLogging, warmFromGuest } from "./warm-harness.ts";

const log = createLogger("modal.sandbox");

// ── WarmHarness construction ─────────────────────────────────────────────────

/**
 * Wrap a Modal sandbox + dialed harness socket into the WarmHarness shape.
 * The lifecycle wiring (exit fan-out, memoized cleanup) lives in
 * warm-harness.ts, shared with the subprocess backend.
 */
function warmFromModal(
  sb: ModalSandboxLike,
  proc: ModalProcLike,
  ws: RpcWebSocket,
  origin: string,
  token: string,
): WarmHarness {
  return warmFromGuest({
    proc,
    terminate: () => sb.terminate(),
    ws,
    origin,
    token,
  });
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a fresh Modal sandbox and dial its WebSocket.
 * The returned WarmHarness has a running harness process and a connected RPC
 * channel, but no listeners attached and no bundle loaded.
 *
 * `slug` and `role` are attached as sandbox tags for observability only
 * (see sandbox-role.ts); the security boundary is Modal's sandbox isolation
 * + network policy.
 */
export async function spawnModalWarm(
  opts: { harnessPath: string; imageTag?: string | undefined } & SpawnIdentity,
  ctx?: ModalSpawnContext,
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const role = resolveSandboxRole(opts);

  const t0 = performance.now();
  const sb = await context.createGuestSandbox(
    code,
    guestSandboxCreateParams({ role, slug: opts.slug, name: opts.name }),
    opts.imageTag,
  );
  try {
    // The per-sandbox bearer token rides the EXEC env — never the sandbox
    // env, where it would outlive the process and show in sandbox metadata.
    const token = randomBytes(32).toString("hex");
    // The tunnel lookup doesn't depend on the exec — dialGuest already
    // retries while the harness boots — so save a Modal control-plane round
    // trip by running the two together.
    const [proc, tunnels] = await Promise.all([
      sb.exec(["node", HARNESS_REMOTE_PATH], {
        mode: "binary",
        stdout: "pipe",
        stderr: "pipe",
        // Compile cache, CONTAINED and the scratch directory — see
        // `guestExecBaseEnv`, which is the whole of what a contained guest gets
        // beyond its own two boot keys.
        env: {
          AAI_GUEST_TOKEN: token,
          AAI_GUEST_PORT: String(GUEST_PORT),
          ...guestExecBaseEnv(),
        },
      }),
      sb.tunnels(),
    ]);
    // Before the dial: a harness that dies during boot must still get its
    // stderr into the host log (see startGuestLogging).
    startGuestLogging(proc, `modal:${sb.sandboxId}`);
    const origin = guestOrigin(tunnels);
    // Wait for Modal's probe rather than discovering readiness by failed
    // dials: the dial's own retry stays as the backstop, but on the happy
    // path it now connects first try instead of polling the boot.
    await raceGuestExit(sb.waitUntilReady(GUEST_READY_TIMEOUT_MS), proc);
    const ws = await dial(guestWsUrl(origin, GUEST_ROUTES.control), token);

    log.debug("Modal sandbox spawned", {
      sandboxId: sb.sandboxId,
      role,
      slug: opts.slug ?? "(none)",
      ms: Math.round(performance.now() - t0),
    });

    return warmFromModal(sb, proc, ws, origin, token);
  } catch (err) {
    // Never leak a sandbox whose harness failed to start.
    await sb.terminate().catch(() => undefined);
    throw new SandboxUnavailableError(`Modal sandbox spawn failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

// ── Test-only internals ──────────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  warmFromModal,
  resetModalContext,
};
