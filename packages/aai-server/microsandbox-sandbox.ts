// Copyright 2026 the AAI authors. MIT license.
/**
 * microVM-backed sandbox spawning — the ISOLATED developer backend.
 *
 * The guest harness runs inside a microsandbox microVM (libkrun on
 * Hypervisor.framework or KVM) booted from the SAME OCI image production pulls,
 * with a published loopback port for the host to dial. Selected in local dev;
 * see `sandbox-backend.ts` for the policy.
 *
 * ## What this gives you that `subprocess` cannot
 *
 * - **A real boundary.** The studio coding agent's `bash` and `run_code` execute
 *   IN THE GUEST (`aai-guest/studio-tools.ts`, `aai-guest/trial.ts`), so under
 *   `subprocess` an LLM-authored shell line runs on the developer's machine with
 *   the server's uid. Here it runs in a VM with its own kernel.
 * - **Enforced limits.** `SANDBOX_MEMORY_LIMIT_MB` becomes real guest memory
 *   rather than V8's `--max-old-space-size` (a JS-heap bound only), and
 *   `SANDBOX_CPU_LIMIT` has an analog at last.
 * - **Production's toolchain.** Guests BUILD workspaces (`aai-guest/
 *   studio-build.ts` runs the CLI's own bundlers), and `subprocess` resolves
 *   that toolchain from aai-guest's own darwin/pnpm `node_modules` while
 *   production resolves `/opt/aai`, an `npm ci` tree on `node:26-slim`. A build
 *   failure caused by the toolchain tree is unreproducible locally under
 *   `subprocess`, by construction.
 *
 * ## What it still does not give you
 *
 * Production confidence — only `SANDBOX_BACKEND=modal` can, because that IS
 * production. The image reference is shared, the image BYTES are not: Modal runs
 * `linux/amd64` and an Apple Silicon host runs `linux/arm64`, so this is the
 * same recipe on a different architecture. Nor is the fleet real: one process,
 * no peers, no cross-replica locks.
 *
 * ## Deliberate parity choices
 *
 * `AAI_GUEST_HOST` is NOT set, so the harness binds `0.0.0.0` exactly as it does
 * under Modal — the override `subprocess` needs (its "guest" shares the dev
 * machine's interfaces) is a workaround for having no namespace, not a
 * convention. The guest reaches no further than its published port either way.
 *
 * `CONTAINED_ENV` IS set, via `guestExecBaseEnv()`: a real VM surrounds this
 * guest, so the SDK's network builtins drop their SSRF screen. That screen
 * guards nothing a tenant cannot bypass from their own tool code, and there are
 * no platform credentials in here to protect.
 *
 * The guest gets a MINIMAL env, never `process.env` — the rule
 * `subprocess-sandbox.ts` argues at length, and for the same reason: agent code
 * that wrongly reads `process.env` must fail here the way it fails in
 * production. What it does get is rewritten for the VM's network namespace; see
 * `microsandbox-network.ts`, which is the difference between `ctx.db` working
 * and silently pointing at the VM's own loopback.
 */

import { access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import type { NetworkPolicyBuilder } from "microsandbox";
import { guestImageRef, guestImageRegistry } from "./guest-image-source.ts";
import { pollGuestHealth } from "./guest-readiness.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import {
  GUEST_EGRESS_DEFAULT,
  GUEST_INGRESS_DEFAULT,
  guestEgressRules,
  rewriteLoopbackForGuest,
} from "./microsandbox-network.ts";
// The paths a guest's boot artifacts live at, from the spawner that defined
// them: one definition of the agent-mode boot convention, and no second
// hardcoded `/tmp` for `guard-invariants` rule 11 to count (these are paths
// INSIDE a linux guest, which is why the Modal side is baselined).
import { AGENT_BUNDLE_REMOTE_PATH, AGENT_ENV_REMOTE_PATH } from "./modal-agent-sandbox.ts";
import { GUEST_PORT, harnessCode, sandboxBaseTag } from "./modal-context.ts";
import {
  guestExecBaseEnv,
  HARNESS_REMOTE_PATH,
  localHarnessImageTag,
} from "./modal-harness-image.ts";
import { parseSandboxLimitsFromEnv } from "./modal-sandbox-env.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { resolveSandboxRole, type SpawnIdentity } from "./sandbox-role.ts";
import type { WarmHarness, WorkerSource } from "./sandbox-vm.ts";
import {
  type AgentServerHandle,
  agentBootEnv,
  agentServerFromGuest,
  type DialGuest,
  dialGuest,
  type GuestFetch,
  type GuestProcLike,
  getFreePort,
  startGuestLogging,
  warmFromGuest,
} from "./warm-harness.ts";

const log = createLogger("sandbox.microsandbox");

/**
 * The image a microsandbox guest boots from when no registry is configured —
 * what `pnpm build:guest-image` writes locally.
 */
export const LOCAL_GUEST_IMAGE_TAG = "aai-guest-harness:local";

// ── Structural sandbox types (injectable — unit tests boot no microVM) ───────

export type MicrosandboxProcLike = GuestProcLike & {
  /** Terminate the exec'd process. Fire-and-forget, like the sibling backends. */
  kill(): void;
};

export type MicrosandboxCreateParams = {
  /** OCI reference to boot from. */
  imageRef: string;
  /** Sandbox name — the fleet identity, and what the manage token derives from. */
  name: string;
  /** Host port published to the guest's {@link GUEST_PORT}. */
  hostPort: number;
  /** The guest's whole environment (already rewritten for the VM). */
  env: Record<string, string>;
  /** Host ports the guest may reach, derived from the env rewrite. */
  hostPorts: readonly number[];
  memoryLimitMiB?: number | undefined;
  cpus?: number | undefined;
  /** Observability labels — the analog of Modal's sandbox tags. */
  labels: Record<string, string>;
};

/** A booted microVM, reduced to what spawning needs. */
export type MicrosandboxHandle = {
  /** Start a long-lived process and stream its stdio. */
  exec(command: string[]): Promise<MicrosandboxProcLike>;
  /** Write a boot artifact into the guest before its exec. */
  writeFile(path: string, data: string): Promise<void>;
  /** Stop the whole VM. */
  stop(): Promise<void>;
};

export type MicrosandboxSpawnContext = {
  createSandbox(params: MicrosandboxCreateParams): Promise<MicrosandboxHandle>;
};

// ── Image reference ──────────────────────────────────────────────────────────

/**
 * Which image a guest boots from: the published, content-addressed one when a
 * registry is configured, else the local build.
 *
 * The registry case reuses `guestImageRef` and `localHarnessImageTag` rather
 * than composing a reference of its own, so a dev pointed at a registry pulls
 * the byte-identical image a deploy would — which is the entire point of the
 * OCI recipe.
 */
export function microsandboxImageRef(
  harnessCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const registry = guestImageRegistry(env);
  return registry === undefined
    ? LOCAL_GUEST_IMAGE_TAG
    : guestImageRef(registry, localHarnessImageTag(sandboxBaseTag(), harnessCode));
}

/**
 * The image reference a deploy PINS when it spawns on this backend, or null.
 *
 * Null for the local image: `aai-guest-harness:local` is a mutable tag that
 * `pnpm build:guest-image` overwrites, so recording it would promise an
 * environment nothing can reproduce. With a registry configured the reference
 * is content-addressed and pinning means what it means on Modal — which is why
 * this backend can honour a pin at all, where `subprocess` never could.
 */
export async function microsandboxHarnessImageTag(harnessPath: string): Promise<string | null> {
  if (guestImageRegistry(process.env) === undefined) return null;
  return localHarnessImageTag(sandboxBaseTag(), await harnessCode(harnessPath));
}

// ── The real context ─────────────────────────────────────────────────────────

/**
 * Adapt one `ExecHandle` to the `GuestProcLike` both spawners consume.
 *
 * The handle is a single async iterable of `{kind}`-tagged events; the host side
 * wants two byte streams plus an exit. The pump NEVER stops early — a guest
 * blocked on a full pipe wedges on its next write, which is the invariant
 * `warm-harness.ts` states for every backend.
 */
function procFromExec(handle: {
  [Symbol.asyncIterator](): AsyncIterator<
    | { kind: "stdout" | "stderr"; data: Uint8Array }
    | { kind: "exited"; code: number }
    | { kind: "started"; pid: number }
  >;
  kill(): Promise<void>;
}): MicrosandboxProcLike {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      out = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      err = controller;
    },
  });

  const exit = (async (): Promise<number> => {
    let code = -1;
    try {
      for await (const event of handle) {
        if (event.kind === "stdout") out.enqueue(event.data);
        else if (event.kind === "stderr") err.enqueue(event.data);
        else if (event.kind === "exited") code = event.code;
      }
    } catch {
      // Peer death mid-stream is the exit paths' business, not this pump's.
    }
    out.close();
    err.close();
    return code;
  })();

  return {
    stdout,
    stderr,
    wait: () => exit,
    kill: () => {
      void handle.kill().catch(() => undefined);
    },
  };
}

/**
 * Map {@link guestEgressRules} onto the SDK's policy builder.
 *
 * Typed against the real `NetworkPolicyBuilder` — the rules being plain data is
 * what lets this be the only place that touches the SDK's shape, with no
 * structural stand-in to bridge and therefore no cast.
 */
function applyPolicy(
  builder: NetworkPolicyBuilder,
  hostPorts: readonly number[],
): NetworkPolicyBuilder {
  builder.defaultEgress(GUEST_EGRESS_DEFAULT).defaultIngress(GUEST_INGRESS_DEFAULT);
  for (const rule of guestEgressRules(hostPorts)) {
    builder.egress((r) => {
      for (const protocol of rule.protocols) {
        if (protocol === "tcp") r.tcp();
        else r.udp();
      }
      if (rule.ports.length > 0) r.ports([...rule.ports]);
      return r.allow((destination) => destination.group(rule.group));
    });
  }
  return builder;
}

/**
 * The real microVM context.
 *
 * The SDK is a DYNAMIC import: `aai-server` is compiled into the studio entry
 * every deployment runs, and a static import of a native addon would put a
 * top-level require of it in that bundle. Backend selection cannot reach this
 * backend in production, so the specifier is never evaluated there — while
 * `import type` keeps the shapes above fully checked.
 */
function realContext(): MicrosandboxSpawnContext {
  return {
    async createSandbox(params) {
      const { Sandbox, NetworkPolicyBuilder } = await import("microsandbox");
      let builder = Sandbox.builder(params.name)
        .image(params.imageRef)
        // The image is built locally or pulled once; never re-fetched per spawn.
        .pullPolicy("if-missing")
        .ephemeral(true)
        .quietLogs()
        .envs(params.env)
        .labels(params.labels)
        // The published port goes INSIDE `.network()`, and that is not a style
        // choice: `.network()` replaces the accumulated network config, so a
        // `.port()` called before it is DISCARDED. The failure is a silent
        // no-forward — the harness logs `listening on 0.0.0.0:8080` inside the
        // guest while every host dial gets ECONNREFUSED for the full 30s dial
        // budget, which reads as a guest that failed to boot.
        //
        // Publishes on 127.0.0.1 by default, which is the loopback posture
        // `subprocess` has to set by hand.
        .network((network) =>
          network
            .port(params.hostPort, GUEST_PORT)
            .policyFromBuilder(applyPolicy(new NetworkPolicyBuilder(), params.hostPorts)),
        );
      if (params.memoryLimitMiB !== undefined) builder = builder.memory(params.memoryLimitMiB);
      if (params.cpus !== undefined) builder = builder.cpus(params.cpus);
      const sandbox = await builder.create();

      return {
        exec: async (command) => {
          const [cmd, ...args] = command;
          if (cmd === undefined) throw new Error("empty guest command");
          return procFromExec(await sandbox.execStream(cmd, args));
        },
        writeFile: (path, data) => sandbox.fs().write(path, data),
        stop: () => sandbox.stop(),
      };
    },
  };
}

// ── Warm (control-channel) spawning ──────────────────────────────────────────

/**
 * Spawn a warm harness in a microVM and dial its control channel. Mirrors
 * `spawnModalWarm`: a running harness and a connected RPC channel, with no
 * listeners attached and no bundle loaded.
 */
export async function spawnMicrosandboxWarm(
  opts: { harnessPath: string } & SpawnIdentity,
  ctx: MicrosandboxSpawnContext = realContext(),
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const slug = opts.slug ?? "(none)";
  const role = resolveSandboxRole(opts);
  const t0 = performance.now();
  try {
    // Checked up front so a missing build fails with the path, not as a dial
    // timeout against a VM whose harness was never there.
    await access(opts.harnessPath);
    const hostPort = await getFreePort();
    const limits = parseSandboxLimitsFromEnv(process.env);
    const name = opts.name ?? `aai-warm-${hostPort}`;
    const token = guestTokenFor(name);

    const sandbox = await ctx.createSandbox({
      imageRef: microsandboxImageRef(await harnessCode(opts.harnessPath)),
      name,
      hostPort,
      // A studio guest carries no tenant DSNs, so there is nothing to rewrite
      // and no host port to open.
      env: { ...guestExecBaseEnv(), AAI_GUEST_TOKEN: token, AAI_GUEST_PORT: String(GUEST_PORT) },
      hostPorts: [],
      memoryLimitMiB: limits.memoryLimitMiB,
      labels: { role, slug },
    });

    const terminate = async (): Promise<void> => {
      await sandbox.stop().catch(() => undefined);
    };

    try {
      const proc = await sandbox.exec(["node", HARNESS_REMOTE_PATH]);
      // Before the dial: a harness that dies during boot must still get its
      // stderr into the host log.
      startGuestLogging(proc, `microsandbox:${hostPort}`);
      const origin = `ws://127.0.0.1:${hostPort}`;
      const ws = await dial(guestWsUrl(origin, GUEST_ROUTES.control), token);
      log.debug("Microsandbox warm harness spawned", {
        role,
        slug,
        hostPort,
        ms: Math.round(performance.now() - t0),
      });
      return warmFromGuest({ proc, terminate, ws, origin, token });
    } catch (err) {
      await terminate();
      throw err;
    }
  } catch (err) {
    throw new SandboxUnavailableError(`Microsandbox spawn failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

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
  ctx: MicrosandboxSpawnContext = realContext(),
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
    // One port set for the policy, from every value that was rewritten.
    const hostPorts = [...new Set([...envPorts, ...worker.hostPorts])].sort((a, b) => a - b);

    const sandbox = await ctx.createSandbox({
      imageRef: microsandboxImageRef(await harnessCode(opts.harnessPath)),
      name: opts.name,
      hostPort,
      env: {
        ...guestExecBaseEnv(),
        ...agentBootEnv({
          slug: opts.slug,
          token,
          port: GUEST_PORT,
          bundle: bundleUrl === undefined ? { path: AGENT_BUNDLE_REMOTE_PATH } : { url: bundleUrl },
          bundleSha256: opts.worker.sha256,
          envPath: AGENT_ENV_REMOTE_PATH,
        }),
      },
      hostPorts,
      memoryLimitMiB: limits.memoryLimitMiB,
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
export const _internals = { procFromExec, realContext };
