// Copyright 2026 the AAI authors. MIT license.
/**
 * AGENT-MODE guest support: the "guest is a server" contract.
 *
 * In agent mode (`AAI_GUEST_MODE=agent`) the guest receives EVERYTHING at
 * exec time and holds no host connection at all:
 *
 * - the agent env arrives as a file written into the sandbox before exec
 *   (`AAI_AGENT_ENV_PATH`), and the worker bundle either as a file
 *   (`AAI_BUNDLE_PATH`) or as a signed URL the guest fetches for itself
 *   (`AAI_BUNDLE_URL`) — {@link readAgentBoot} loads it and hash-verifies it
 *   against `AAI_BUNDLE_SHA256` either way;
 * - the platform's remaining needs are a token-gated HTTP surface —
 *   {@link createManageHandler}: `GET /manage/status` (the idle-eviction and
 *   retire-drain probe) and `POST /manage/drain` (stop accepting sessions,
 *   exit when the last one ends);
 * - lifecycle is owned by the guest — {@link createIdleController} self-exits
 *   after an idle window (there is no host socket whose absence could signal
 *   orphanhood) and finishes a drain.
 *
 * Everything the host trusts stays untrusted-guest-safe: the manage surface
 * only reports THIS tenant's own session count, and the bearer only gates
 * who may probe/drain this one sandbox. Like the rest of the harness, this
 * file is bundled into the self-contained guest artifact — node builtins
 * only, zero workspace imports.
 */

import { readFile, rm } from "node:fs/promises";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { createRuntimeServer } from "@alexkroman1/aai-runtime";
import { agentServerEnv } from "@alexkroman1/aai-runtime/internal";
import { emptyHarnessState, lazyRuntime, loadBundle } from "./harness-bundle.ts";
import { bundleSourceOf, readVerifiedBundle } from "./harness-bundle-source.ts";
import { createAgentRequestHandler, createWorkflowActivity } from "./harness-manage.ts";
import { guestSdkVersion } from "./harness-sdk-version.ts";
import { AGENT_IDLE_EXIT_MS, AGENT_IDLE_POLL_MS } from "./limits.ts";

// ---- Boot artifacts ----------------------------------------------------------

export type AgentBoot = {
  /** The worker bundle source (hash-verified). */
  code: string;
  /** The agent's env (`ctx.env` + provider credentials + DATABASE_URL). */
  env: Record<string, string>;
};

/**
 * Read the boot artifacts the spawner delivered into the sandbox.
 *
 * The bundle arrives one of two ways, and the spawner picks by naming one env
 * var or the other: `AAI_BUNDLE_PATH` for a file written into the sandbox
 * before exec, `AAI_BUNDLE_URL` for a time-boxed signed Storage URL the guest
 * FETCHES ITSELF. The second is the platform's path — it stops the ~8 MB
 * bundle from crossing the platform twice on every cold spawn — and it is
 * safe for exactly one reason: the hash below. `AAI_BUNDLE_SHA256` is the
 * agents row's own record of what the deploy published, so the guest trusts
 * the HASH and never the transport, the URL, or whoever served it. A mismatch
 * is a hard boot failure (exit, respawn), never a silently different agent.
 *
 * The env file is best-effort deleted after reading so the secrets live in
 * process memory rather than on the sandbox disk.
 */
export async function readAgentBoot(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentBoot> {
  const expected = env.AAI_BUNDLE_SHA256;
  const source = bundleSourceOf(env.AAI_BUNDLE_URL, env.AAI_BUNDLE_PATH);
  if (!(expected && source)) {
    throw new Error("agent mode requires AAI_BUNDLE_SHA256 and one of AAI_BUNDLE_PATH/_URL");
  }
  const code = await readVerifiedBundle(source, expected);
  return { code, env: await readAgentEnvFile(env.AAI_AGENT_ENV_PATH) };
}

/**
 * The agent's env, best-effort deleted after reading so the secrets live in
 * process memory rather than on the sandbox disk. An absent path is a legal
 * boot with an empty env; a malformed file is not.
 */
async function readAgentEnvFile(envPath: string | undefined): Promise<Record<string, string>> {
  if (!envPath) return {};
  const raw = JSON.parse(await readFile(envPath, "utf-8")) as unknown;
  // `isRecord` rather than the hand-written negated disjunction: the guard also
  // rules out an array, which was the third clause here, and it is the one
  // spelling `guard-invariants` rule 17 recognizes.
  if (!isRecord(raw)) {
    throw new Error("agent env file must contain a JSON object");
  }
  const agentEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new Error(`agent env value for ${key} must be a string`);
    }
    agentEnv[key] = value;
  }
  await rm(envPath, { force: true }).catch(() => undefined);
  return agentEnv;
}

// ---- Idle / drain lifecycle ---------------------------------------------------

export type IdleController = {
  isDraining: () => boolean;
  startDrain: (deadlineMs?: number) => void;
  /** Stop the poll timer (tests). */
  stop: () => void;
};

/**
 * Guest-owned lifecycle: exit 0 once idle past `idleExitMs` (0 disables); a
 * requested drain exits as soon as the sessions hit zero, or at the drain's
 * own deadline regardless (retirement is fire-and-forget host-side — the
 * guest enforces the budget on itself). This replaces the control-channel
 * orphan timeout — an agent-mode guest has no host socket, so "nobody needs
 * me" is measured by its own session count.
 */
export function createIdleController(opts: {
  activeSessions: () => number;
  /**
   * Durable-workflow callbacks in flight (see {@link createWorkflowActivity}).
   *
   * Counted as busy for BOTH windows, and the drain half is deliberate rather
   * than incidental: a drain means "finish what you are doing, bounded by the
   * deadline", and a step the platform woke this sandbox to run is exactly that.
   * Absent means "this guest has no workflows", not "ignore them".
   */
  activeWorkflows?: (() => number) | undefined;
  idleExitMs: number;
  pollMs: number;
  /** Injectable for tests. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  now?: () => number;
}): IdleController {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? Date.now;
  let draining = false;
  let drainDeadline = Number.POSITIVE_INFINITY;
  let lastBusy = now();
  const busy = (): number => opts.activeSessions() + (opts.activeWorkflows?.() ?? 0);

  const tick = (): void => {
    if (draining && now() >= drainDeadline) {
      console.error("agent guest drain deadline reached; exiting with sessions live");
      exit(0);
      return;
    }
    if (busy() > 0) {
      lastBusy = now();
      return;
    }
    if (draining) {
      console.error("agent guest drained: no live sessions; exiting");
      exit(0);
      return;
    }
    if (opts.idleExitMs > 0 && now() - lastBusy > opts.idleExitMs) {
      console.error(`agent guest idle for ${opts.idleExitMs}ms; exiting`);
      exit(0);
    }
  };
  const timer = setInterval(tick, opts.pollMs);
  timer.unref?.();

  return {
    isDraining: () => draining,
    startDrain: (deadlineMs?: number) => {
      draining = true;
      if (deadlineMs !== undefined) {
        drainDeadline = Math.min(drainDeadline, now() + deadlineMs);
      }
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * AGENT MODE — the "guest is a server" contract (see harness-agent-mode.ts).
 * Everything arrives at exec time: the bundle and env are read (and the
 * bundle hash-verified) from files the spawner wrote into the sandbox, the
 * bundle is loaded BEFORE listen (so a 200 from /health means "ready"), and
 * there is NO host control channel — the platform's only surfaces are the
 * public session endpoints and the token-gated /manage/* pair. Lifecycle is
 * guest-owned: idle self-exit replaces the orphan timeout, and a drain
 * refuses new sessions then exits with the last one.
 */
export async function mainAgent(port: number, host: string, token: string): Promise<void> {
  const state = emptyHarnessState();

  // Armed BEFORE the boot artifacts load, so a guest whose bundle never loads still
  // has a clock. Its only consumer now is the idle controller: a workflow callback
  // in flight counts as busy, which is what stops a sandbox self-exiting five
  // minutes into an hour-long run.
  const activity = createWorkflowActivity();

  const rawIdle = Number(process.env.AAI_GUEST_IDLE_EXIT_MS ?? AGENT_IDLE_EXIT_MS);
  const idle = createIdleController({
    activeSessions: () => state.activeSessions,
    activeWorkflows: activity.inFlight,
    idleExitMs: Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : AGENT_IDLE_EXIT_MS,
    pollMs: AGENT_IDLE_POLL_MS,
  });

  const boot = await readAgentBoot();

  await loadBundle(state, { code: boot.code, env: boot.env });

  // A draining guest is detached from the broker, but a client holding its
  // old sessionUrl can still dial the tunnel directly — refuse with a "try
  // again" close so the client re-brokers onto the replacement.
  const runtime = lazyRuntime(state, {
    refuse: () => (idle.isDraining() ? { code: 1013, reason: "draining" } : null),
  });

  const server = createRuntimeServer({
    runtime,
    // The agent's own env, and its ABSENCE here was a bug with three symptoms.
    // `createRuntimeServer` reads four things out of it, and a deployed agent got none:
    //
    // - `DATABASE_URL`, which is where a workflow upload's RECORD lives. Without it
    //   `installWorkflowSupport` built a store with no database — so every deployed
    //   agent's uploads went to the old file backend in the container's `/tmp` and
    //   were gone by the time a resumed run read them, however the app database was
    //   provisioned. That is the exact failure `aai/host/_upload-store.ts` warns
    //   about, and it was silent until the file backend stopped existing.
    // - `AAI_WORKFLOW_API_TOKEN`, the gate on `/workflows/*`. `aai-server`'s guide
    //   says that gate "is what closes" the proxied workflow route; it was never
    //   applied, so an agent that set the secret was still serving the API open.
    // - `AAI_SESSION_EVENTS_TOKEN`, the same shape one route over.
    //
    // The fourth is `AAI_ALLOW_HOST`, and it must NOT ride along — hence
    // `agentServerEnv`, which is the runtime's now rather than a copy of the line
    // here (`createAgentServer` had this same bug and needs the same filter). A
    // deployed agent has NO host mode: `?host=1` lets a caller supply its own agent
    // definition, this server's `/websocket` has no authentication of its own, and
    // the sandbox tunnel URL is public — so a TENANT setting one secret would be
    // handing a stranger their own provider credentials.
    env: agentServerEnv(boot.env),
    // The platform's own origin plus this agent's slug, translated from one `AAI_*`
    // key exactly as `ensureRuntime` translates `AAI_PUBLIC_BASE_URL` for
    // `publicWebhookUrl`. A SECOND key carrying the same value, because the two claims
    // are different and a self-hosted agent makes only one of them — `agentBootEnv` in
    // aai-server carries the argument. Its presence is what puts an upload's bytes on
    // the brokered path, where the platform holds the bucket credential and this guest
    // holds none (see `aai/host/_upload-blobs.ts`).
    ...omitUndefined({ uploadBroker: process.env.AAI_UPLOAD_BROKER_URL?.trim() || undefined }),
    // The guest is the authority on the agent's public client config: the
    // platform's `GET /:slug/client-config` broker PROXIES this server's
    // own `/client-config` for name/greeting, so the bundle's live agent
    // definition — interpreted by the bundle's own SDK — is what renders,
    // and the host never reads fields out of the stored config.
    //
    // Both guards are load-bearing at RUNTIME even though `AgentDef` declares
    // the two fields required: `state.agent` is a tenant object asserted to
    // `AgentDef` at load (`harness-bundle.ts`), so a bundle can ship neither.
    // The types cannot see that, which is why a checker will call these dead.
    ...omitUndefined({
      name: state.agent?.name,
      greeting: state.agent?.greeting,
      // The workflow-app declaration, honoured identically to `aai dev`: the
      // voice surfaces are declined with a reason and telephony defaults off.
      page: state.agent?.page,
    }),
    request: createAgentRequestHandler({
      manage: {
        token,
        activeSessions: () => state.activeSessions,
        isDraining: idle.isDraining,
        startDrain: idle.startDrain,
      },
      // The platform's delivery door reaches the ENGINE through this. A getter,
      // because reading it is what builds the runtime — see `lazyRuntime`.
      deliverWorkflow: () => runtime.deliverWorkflow,
      activity,
    }),
  });
  await server.listen(port, host);
  // See `harness.ts`'s twin line: the version is the copy BESIDE the harness,
  // which is the one this agent's own runtime came from.
  console.error(`agent-mode harness listening on ${host}:${port} (aai ${guestSdkVersion()})`);

  // The world start that used to follow this line is gone with the DevKit, and
  // the ordering it needed is worth recording because it was subtle: `start()`
  // re-enqueued every active run, so a world started before `listen` claimed
  // jobs this server could not yet answer — and each such claim BURNED AN
  // ATTEMPT, measured on a real guest as `Failed task 47 (workflow_steps,
  // 92.36ms, attempt 2 of 3) with error 'Unable to resolve base URL for workflow
  // queue.'` logged 8ms before `harness listening`. At `max_attempts` 3, three
  // boots failed a step permanently.
  //
  // The replay engine has no such step. It re-walks a run only when a delivery
  // arrives on `POST /workflow-queue`, which this server is listening for by the
  // time the platform can reach it, and `claimAttempt` is taken inside the walk
  // rather than by a queue racing the bind.
}
