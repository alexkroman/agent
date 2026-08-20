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
import type http from "node:http";
import { requestQuery } from "@alexkroman1/aai/internal";
import {
  configureWorkflowWorld,
  consoleLogger,
  createServer,
  createWakeHintPublisher,
  handleWorkflowRequest,
  startWorkflowWorldIfDeclared,
  type WorkflowSurface,
} from "@alexkroman1/aai/runtime";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { verifyBearer } from "./harness-auth.ts";
import { emptyHarnessState, lazyRuntime, loadBundle } from "./harness-bundle.ts";
import { bundleSourceOf, readVerifiedBundle } from "./harness-bundle-source.ts";
import { guestLogBuffer, parseLogQuery } from "./harness-logs.ts";
import { guestSdkVersion } from "./harness-sdk-version.ts";
import { AGENT_IDLE_EXIT_MS, AGENT_IDLE_POLL_MS, GUEST_CONTRACT_VERSION } from "./limits.ts";

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

// ---- Manage surface ----------------------------------------------------------

/** Paths of the token-gated management surface. */
export const MANAGE_STATUS_PATH = "/manage/status";
export const MANAGE_DRAIN_PATH = "/manage/drain";
export const MANAGE_LOGS_PATH = "/manage/logs";

export type ManageDeps = {
  /** The per-sandbox bearer (AAI_GUEST_TOKEN) gating this surface. */
  token: string;
  /** Live client-session count (the harness state's counter). */
  activeSessions: () => number;
  /** True once a drain was requested. */
  isDraining: () => boolean;
  /**
   * Request a drain: refuse new sessions, exit when the last one ends —
   * or at `deadlineMs` from now regardless (the host's retire budget; a
   * drained guest is superseded code, so it must not outlive one long
   * call indefinitely). Absent deadline: drain until empty.
   */
  startDrain: (deadlineMs?: number) => void;
};

/**
 * The drain deadline off the request's query (`?deadlineMs=600000`). A query
 * param rather than a body: the server's request hook hands over a
 * query-stripped path, so the raw `req.url` is the one place the value
 * rides, and a number in a query needs no body reader, no size cap, and no
 * JSON parsing. Absent/malformed reads as "drain until empty".
 */
function drainDeadlineMs(req: http.IncomingMessage): number | undefined {
  const raw = requestQuery(req.url).get("deadlineMs");
  const ms = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The `request` hook serving `/manage/*`. Claims every `/manage` path
 * (unauthenticated ones with a 401 — the tunnel URL is public, the bearer is
 * what keeps this from being an open door), leaves everything else to the
 * server's own routing.
 */
export function createManageHandler(
  deps: ManageDeps,
): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  return (req, res, url, method) => {
    if (!url.startsWith("/manage/")) return false;
    if (!verifyBearer(req.headers.authorization, deps.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (method === "GET" && url === MANAGE_STATUS_PATH) {
      sendJson(res, 200, {
        activeSessions: deps.activeSessions(),
        draining: deps.isDraining(),
        contractVersion: GUEST_CONTRACT_VERSION,
      });
      return true;
    }
    if (method === "POST" && url === MANAGE_DRAIN_PATH) {
      deps.startDrain(drainDeadlineMs(req));
      sendJson(res, 200, { ok: true, draining: true });
      return true;
    }
    // This guest's own stdout/stderr, by cursor. Served from here rather than
    // from the host because a buffer in host memory is readable on one replica
    // only — see harness-logs.ts.
    if (method === "GET" && url === MANAGE_LOGS_PATH) {
      const { after, limit } = parseLogQuery(requestQuery(req.url));
      sendJson(res, 200, guestLogBuffer().read(after, limit));
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  };
}

/**
 * Workflow work in flight, so the idle controller can see it.
 *
 * A guest measures "nobody needs me" by its session count, which is the whole
 * truth for a voice agent and half of it for one with durable workflows: a run
 * woken by the platform (`aai-server/workflow-wake.ts`) has NO session, so
 * without this the sandbox self-exits five minutes into an hour-long run —
 * mid-step, leaving the job locked until graphile-worker's 4-hour expiry lets
 * another worker rescue it. The wake would then have bought at most one idle
 * window of progress per sweep.
 *
 * Settlement is the RESPONSE's `close`, which fires whether the handler answered
 * or the socket died, so a callback cannot leak the counter and pin a sandbox
 * alive forever. It is also the completion signal `handleWorkflowRequest` itself
 * does not give: it returns `true` synchronously and serves in the background.
 *
 * @internal
 */
export type WorkflowActivity = {
  /** Callbacks currently being served. */
  inFlight: () => number;
  /** Note one claimed workflow request; its response settles it. */
  begin: (res: http.ServerResponse) => void;
};

/**
 * Track in-flight workflow callbacks, notifying `onSettled` as each finishes.
 *
 * `onSettled` is where the wake hint is republished: a callback finishing is
 * exactly the moment the queue's next-claimable time changed, so it is both the
 * cheapest and the most accurate trigger available.
 *
 * @internal
 */
export function createWorkflowActivity(onSettled?: () => void): WorkflowActivity {
  let inFlight = 0;
  return {
    inFlight: () => inFlight,
    begin(res) {
      inFlight += 1;
      // `once`, and on `close` rather than `finish`: a response that never
      // finishes (an aborted connection mid-step) must still release the count.
      res.once("close", () => {
        inFlight -= 1;
        onSettled?.();
      });
    },
  };
}

/**
 * Agent mode's whole `request` hook: the DevKit's queue callbacks, then the
 * manage surface.
 *
 * Workflows go FIRST because the paths are disjoint and this is the hotter one
 * on an agent that has any; unclaimed they would fall through to the server's
 * 404 and every run would stall with nothing saying why. The workflow surface is
 * read through a getter rather than passed by value because the bundle is loaded
 * before this is built but the two are independently replaceable, and a captured
 * `null` would leave a reloaded bundle's routes unmounted.
 */
export function createAgentRequestHandler(deps: {
  manage: ManageDeps;
  workflows: () => WorkflowSurface | null;
  /** Absent leaves workflow work invisible to the idle controller — tests only. */
  activity?: WorkflowActivity | undefined;
}): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  const manage = createManageHandler(deps.manage);
  return (req, res, url, method) => {
    if (handleWorkflowRequest(deps.workflows(), req, res, url, method)) {
      deps.activity?.begin(res);
      return true;
    }
    return manage(req, res, url, method);
  };
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
/**
 * The agent's env as `createServer` may read it: everything except the host-mode gate.
 *
 * A deployed agent has NO host mode — `aai-server`'s guide has the argument, and the
 * platform's own in-process version was deliberately removed. But the gate
 * `createServer` consults is `isHostAllowed(env)`, so handing it the agent's env
 * unfiltered would let a TENANT turn host mode on inside their own guest by setting one
 * secret. That is not theirs to enable: `?host=1` lets a caller supply its own agent
 * definition, the guest's `/websocket` has no authentication of its own, and the sandbox
 * tunnel URL is public — so the caller would be driving that agent's provider
 * credentials with a prompt of their choosing.
 *
 * Omitting the key rather than adding a `hostMode: "off"` option, because the SDK's
 * contract is already "no env, no host mode" and this is the guest saying which env it
 * is willing to have read. A new option would be a second way to express one rule.
 */
export function agentServerEnv(env: Record<string, string>): Record<string, string> {
  const { AAI_ALLOW_HOST: _ignored, ...rest } = env;
  return rest;
}

export async function mainAgent(port: number, host: string, token: string): Promise<void> {
  const state = emptyHarnessState();

  // The publisher needs the agent's DATABASE_URL, which arrives with the boot
  // artifacts below — while the idle controller has to arm BEFORE them, so a
  // guest whose bundle never loads still has a clock. Hence the indirection:
  // the activity tracker exists from the start and its settle callback finds a
  // publisher once there is one.
  let publishWakeHint: () => void = () => undefined;
  const activity = createWorkflowActivity(() => publishWakeHint());

  const rawIdle = Number(process.env.AAI_GUEST_IDLE_EXIT_MS ?? AGENT_IDLE_EXIT_MS);
  const idle = createIdleController({
    activeSessions: () => state.activeSessions,
    activeWorkflows: activity.inFlight,
    idleExitMs: Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : AGENT_IDLE_EXIT_MS,
    pollMs: AGENT_IDLE_POLL_MS,
  });

  const boot = await readAgentBoot();

  // BEFORE the bundle loads: `loadBundle` builds the workflow surface, which
  // imports `workflow/runtime`, which resolves and CACHES a world from the
  // environment. Configured after, a production guest would silently take the
  // local world and write runs into a container about to be destroyed.
  const world = configureWorkflowWorld({ databaseUrl: boot.env.DATABASE_URL, port });

  await loadBundle(state, { code: boot.code, env: boot.env });

  // Gated on the bundle actually declaring workflows: migrating and subscribing
  // a queue are both expensive and most agents have none. A failure is logged
  // rather than thrown — the session surface is unaffected, and an agent whose
  // workflows are broken should still answer the phone.
  await startWorkflowWorldIfDeclared(state.workflows !== null, world);

  // The wake hint — how a run whose sandbox is gone gets a process again (see
  // `aai/host/workflow-wake-hint.ts` for the design, and
  // `aai-server/workflow-wake.ts` for the reader). Only for an agent that
  // declares workflows AND has a database: the local world's queue is in memory,
  // so there is nothing for the platform to wake it for. Published once here so a
  // hint a previously killed guest never got to write is repaired by any boot,
  // then after every queue callback.
  if (state.workflows !== null && boot.env.DATABASE_URL) {
    const wake = createWakeHintPublisher({
      databaseUrl: boot.env.DATABASE_URL,
      logger: consoleLogger,
    });
    publishWakeHint = () => void wake.publish();
    publishWakeHint();
  }

  // A draining guest is detached from the broker, but a client holding its
  // old sessionUrl can still dial the tunnel directly — refuse with a "try
  // again" close so the client re-brokers onto the replacement.
  const runtime = lazyRuntime(state, {
    refuse: () => (idle.isDraining() ? { code: 1013, reason: "draining" } : null),
  });

  const server = createServer({
    runtime,
    // The agent's own env, and its ABSENCE here was a bug with three symptoms.
    // `createServer` reads four things out of it, and a deployed agent got none:
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
    // `agentServerEnv`.
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
      workflows: () => state.workflows,
      activity,
    }),
  });
  await server.listen(port, host);
  // See `harness.ts`'s twin line: the version is the copy BESIDE the harness,
  // which is the one this agent's own runtime came from.
  console.error(`agent-mode harness listening on ${host}:${port} (aai ${guestSdkVersion()})`);
}
