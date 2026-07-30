// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox backed by remote Modal Sandboxes.
 *
 * The host runs `createRuntime()` with VM-backed `executeTool`, giving it
 * the same session/S2S/WebSocket handling as self-hosted mode without
 * duplicating any of that logic.
 *
 * Communication with the guest uses NDJSON over stdio pipes,
 * mediated by the `SandboxHandle` from `sandbox-vm.ts`.
 */

import { randomUUID } from "node:crypto";
import { errorMessage, SESSION_RESUME_GRACE_MS, toolError } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import {
  type AgentRuntime,
  type CloseableDb,
  createGenerateFn,
  createMemoryVector,
  createRuntime,
  type ExecuteTool,
  type Runtime,
  resolveVector,
  safeFetch,
  type Vector,
} from "@alexkroman1/aai/runtime";
import { sendAllowedHosts } from "@alexkroman1/aai/send";
import { debug } from "./_debug-log.ts";
import {
  createMessageDeltaTracker,
  isMessagesDesync,
  type MessagesDelta,
} from "./_sandbox-messages.ts";
import { type AppDatabases, type AppDbMeta, parseAppDbMeta } from "./app-database.ts";
import { createClientSendHandler } from "./client-send.ts";
import { resolveHarnessPath } from "./constants.ts";
import { type IsolateConfig, ToolCallResponseSchema } from "./rpc-schemas.ts";
import { pipelineProviderOpts, toRuntimeAgent } from "./sandbox-agent-config.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { attachSandbox, setSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import { createSandboxVm } from "./sandbox-vm.ts";
import { appDbSecretName, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

// ── Re-exports consumed by orchestrator / handlers / tests ──────────────

export {
  type AgentSlot,
  createSlotCache,
  type SlotCache,
  terminateSlot,
  withSlugLock,
} from "./sandbox-slots.ts";
export type { AgentMetadata } from "./schemas.ts";

// ── Types ───────────────────────────────────────────────────────────────

export type SandboxOptions = {
  workerCode: string;
  env: Record<string, string>;
  slug: string;
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfig;
  /**
   * App database handle when storage is enabled for this app (see
   * app-database.ts). The sandbox takes ownership and closes it on shutdown.
   */
  db?: CloseableDb;
  /** Optional pre-warmed harness pool for faster cold starts. */
  pool?: SandboxPool;
  /**
   * Factory that creates the platform-default Vector for a given agent slug.
   * Used when the agent config does not declare a `vector` provider.
   * If omitted, falls back to an in-memory vector store.
   */
  defaultVector?: (slug: string) => Vector;
  /**
   * Called when the sandbox VM fails to start (rejected `vmReady`). The
   * sandbox object was already returned synchronously by then, so this is
   * the caller's hook to detach a now-permanently-broken sandbox from
   * wherever it was installed.
   */
  onVmFailed?: (err: unknown) => void;
};

export type Sandbox = AgentRuntime & {
  /**
   * One connectionless sync turn against this agent (`POST /:slug/sync`) —
   * see `host/sync-turn.ts` in the SDK. Wrapped here so the guest's
   * per-session tool state (message cache, ctx.state) is released after the
   * turn, the job `session/end` does for WebSocket sessions.
   */
  runSyncTurn: Runtime["runSyncTurn"];
};

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Resolve the Vector store an agent gets: its declared `vector:` provider
 * or the platform default factory (in-memory when none is supplied).
 */
export function resolveAgentVector(
  slug: string,
  config: Pick<IsolateConfig, "vector"> | null,
  env: Record<string, string>,
  defaultVector?: (slug: string) => Vector,
): Vector {
  if (config?.vector) return resolveVector(config.vector, env, slug);
  return defaultVector ? defaultVector(slug) : createMemoryVector({ namespace: slug });
}

/**
 * The hostnames guest tool code may reach: the agent's own `allowedHosts`
 * plus the webhook host of any declared send channel — declaring the channel
 * is the egress opt-in, so an agent's own tool calling `openSender` works
 * without the author also hand-listing `hooks.slack.com`.
 *
 * Derived **host-side from the validated descriptor**, not read from a
 * bundle-supplied field: the deploy path builds its config with
 * `toAgentConfig`, which has no `allowedHosts` at all, and a bundle must not
 * be able to widen its own egress by naming hosts a channel doesn't use.
 */
function resolveAgentAllowedHosts(config: Pick<IsolateConfig, "allowedHosts" | "send">): string[] {
  return [...new Set([...(config.allowedHosts ?? []), ...sendAllowedHosts(config.send)])];
}

export function createSandbox(opts: SandboxOptions): Sandbox {
  const { workerCode, env, slug, db } = opts;

  const config = opts.agentConfig;

  const harnessPath = resolveHarnessPath();

  const vector: Vector = resolveAgentVector(slug, config, env, opts.defaultVector);

  const vmReady = createSandboxVm(
    {
      slug,
      workerCode,
      env,
      // ctx.db for guest tool code, proxied over the db/query RPC. Absent
      // (storage not enabled) the guest's ctx.db getter throws guidance.
      ...(db && { db }),
      vector,
      // Guest ctx.generate: one-shot LLM calls on the agent's own pipeline
      // descriptor (per-call overrides allowed), credentials strictly from
      // the agent env — never platform-owned keys.
      generate: createGenerateFn({ llm: config.llm, env }),
      harnessPath,
      allowedHosts: resolveAgentAllowedHosts(config),
    },
    opts.pool,
  );

  // Ships only the history the guest doesn't already hold on each
  // tool/execute (see _sandbox-messages.ts) — late-session calls used to pay
  // stringify + pipe + parse of the full transcript per step.
  const messageTracker = createMessageDeltaTracker();

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    let sandboxHandle: Awaited<typeof vmReady>;
    try {
      sandboxHandle = await vmReady;
    } catch (err: unknown) {
      return toolError(`Sandbox failed to start: ${errorMessage(err)}`);
    }
    const sid = sessionId ?? "";
    const history = messages ?? [];
    const send = async (delta: MessagesDelta): Promise<unknown> => {
      try {
        return await sandboxHandle.conn.sendRequest("tool/execute", {
          name,
          args,
          sessionId: sid,
          ...delta,
        });
      } catch (err) {
        // The guest may or may not have applied this delta — next call must
        // carry full history.
        messageTracker.reset(sid);
        throw err;
      }
    };
    let raw: unknown;
    try {
      raw = await send(messageTracker.delta(sid, history));
      if (isMessagesDesync(raw)) {
        // The guest lost the prefix (restart, cache eviction) — retry once
        // with the full history.
        messageTracker.reset(sid);
        raw = await send(messageTracker.delta(sid, history));
      }
    } catch (err: unknown) {
      // RPC failure (guest died, timeout) — name the tool at this layer so
      // the error the LLM sees is actionable.
      return toolError(`Tool "${name}" failed in sandbox: ${errorMessage(err)}`);
    }
    const parsed = ToolCallResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.result;
    }
    if (typeof raw === "object" && raw !== null && "error" in raw) {
      return String((raw as { error: unknown }).error);
    }
    return "Tool execution failed: invalid response from sandbox";
  };

  // Builtin resolution (including "a custom tool of the same name wins") lives
  // in createRuntime, so the platform and `aai dev` cannot disagree about which
  // builtins an agent gets. This previously resolved them here off
  // `config.builtinTools ?? []`, which silently dropped the default cognitive
  // builtins for every deployed agent that didn't set `builtinTools`: the
  // deploy path builds its config with `toAgentConfig`, not `parseManifest`,
  // and only the latter fills in DEFAULT_BUILTIN_TOOLS.
  const agentRuntime = createRuntime({
    agent: toRuntimeAgent(config),
    env,
    executeTool,
    // Host-side builtins get the same ctx.db the guest proxies to.
    ...(db && { db }),
    toolSchemas: config.toolSchemas,
    // The SDK's SSRF-protected fetch (also the default inside
    // resolveAllBuiltins) — passed explicitly so the platform's egress policy
    // is visible here rather than only implied by a default.
    fetch: safeFetch,
    ...pipelineProviderOpts(config),
  });

  const sessionSinks = new Map<string, ClientSink>();

  // Deferred guest `session/end` notifications, keyed by session id. The
  // guest's session state (ctx.state, message cache) is keyed by that id, and
  // a disconnected client may resume it (`?sessionId=<id>`) — sending
  // session/end the moment the socket closed wiped the guest's ctx.state
  // before any resume could land, so every resumed session ran the agent with
  // fresh state. Mirror of the SDK runtime's grace-window state sweep.
  const pendingSessionEnds = new Map<string, NodeJS.Timeout>();

  function scheduleSessionEnd(sessionId: string): void {
    cancelSessionEnd(sessionId);
    const timer = setTimeout(() => {
      pendingSessionEnds.delete(sessionId);
      vmReady
        .then((handle) => handle.conn.sendNotification("session/end", { sessionId }))
        .catch(() => {
          // VM failed to start — session/end notification is best-effort
        });
    }, SESSION_RESUME_GRACE_MS);
    timer.unref?.();
    pendingSessionEnds.set(sessionId, timer);
  }

  function cancelSessionEnd(sessionId: string): void {
    const timer = pendingSessionEnds.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingSessionEnds.delete(sessionId);
  }

  vmReady
    .then((handle) => {
      handle.conn.onNotification("client/send", createClientSendHandler(sessionSinks));
      debug("Sandbox ready", { slug, agent: config.name });
    })
    .catch((err: unknown) => {
      console.error("Sandbox VM failed to start", { slug, error: errorMessage(err) });
      opts.onVmFailed?.(err);
    });

  debug("Sandbox initializing", { slug, agent: config.name });

  async function shutdownSandbox(): Promise<void> {
    sessionSinks.clear();
    // The guest process is going down with us — nothing left to notify.
    for (const timer of pendingSessionEnds.values()) clearTimeout(timer);
    pendingSessionEnds.clear();
    try {
      const handle = await vmReady;
      await handle.shutdown();
    } catch {
      // VM failed to start or already shut down
    }
    await agentRuntime.shutdown();
    // The sandbox owns the app db handle it was created with.
    await db?.close().catch(() => undefined);
  }

  const originalStartSession = agentRuntime.startSession.bind(agentRuntime);
  function startSessionWithCleanup(
    ws: Parameters<typeof originalStartSession>[0],
    opts?: Parameters<typeof originalStartSession>[1],
  ): void {
    originalStartSession(ws, {
      ...opts,
      onSinkCreated(sessionId, sink) {
        // A resume under this id keeps its guest-side session state — cancel
        // the deferred session/end the previous connection scheduled.
        cancelSessionEnd(sessionId);
        sessionSinks.set(sessionId, sink);
        opts?.onSinkCreated?.(sessionId, sink);
      },
      onSessionEnd(sessionId) {
        sessionSinks.delete(sessionId);
        // Reset the delta tracker eagerly — the next call (resumed or not)
        // just pays one full-history send. The guest's session state, by
        // contrast, is unrecoverable once freed, so its release waits out
        // the resume grace window.
        messageTracker.reset(sessionId);
        scheduleSessionEnd(sessionId);
        opts?.onSessionEnd?.(sessionId);
      },
    });
  }

  const runSyncTurn: Sandbox["runSyncTurn"] = async (req, syncOpts) => {
    const sessionId = syncOpts?.sessionId ?? `sync:${randomUUID()}`;
    try {
      return await agentRuntime.runSyncTurn(req, { sessionId });
    } finally {
      // Mirror onSessionEnd for WebSocket sessions: drop the host-side
      // message-delta cache and tell the guest to free its session state.
      messageTracker.reset(sessionId);
      vmReady
        .then((handle) => handle.conn.sendNotification("session/end", { sessionId }))
        .catch(() => {
          // VM failed to start — session/end notification is best-effort
        });
    }
  };

  return {
    readyConfig: agentRuntime.readyConfig,
    startSession: startSessionWithCleanup,
    runSyncTurn,
    shutdown: shutdownSandbox,
  };
}

// ── Resolve sandbox (slot-based) ────────────────────────────────────────

type ResolveAppDbOpts = {
  secrets?: SecretStore | undefined;
  appDb?: AppDatabases | undefined;
};

/**
 * Read the app's stored `app-db:` credentials (when the platform can open
 * them). Resolves null when storage is not enabled or unconfigured.
 */
function readAppDbMeta(slug: string, opts: ResolveAppDbOpts) {
  return opts.secrets && opts.appDb
    ? opts.secrets.get(appDbSecretName(slug)).then(parseAppDbMeta)
    : Promise.resolve(null);
}

type ResolveSandboxOpts = {
  slots: import("./sandbox-slots.ts").SlotCache;
  store: BundleStore;
  /** Named secret storage — read for the app's `app-db:` credentials. */
  secrets?: SecretStore;
  /** Per-app database opener; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  pool?: SandboxPool;
  defaultVector?: (slug: string) => Vector;
};

/**
 * Build the slot's sandbox from its loaded bundle parts, wiring the
 * poisoned-sandbox detach: a rejected vmReady leaves the sandbox permanently
 * broken (every tool call fails) while live traffic keeps clearing its idle
 * timer, so it would never self-heal. Detach it so the next connection
 * rebuilds — identity-checked and under the slug lock so a deploy/delete
 * that already replaced the slot is never raced. (createSandbox returns
 * synchronously and the caller's attachSandbox runs in the same task, so the
 * async failure callback can only fire after the attach.)
 */
function buildSlotSandbox(
  slug: string,
  parts: {
    workerCode: string;
    env: Record<string, string>;
    agentConfig: IsolateConfig;
    appDbMeta: AppDbMeta | null;
  },
  opts: ResolveSandboxOpts,
): Sandbox {
  // Open the app db here — cheap, postgres connects on first query; the
  // sandbox owns the handle and closes it on shutdown.
  const db: CloseableDb | undefined =
    parts.appDbMeta && opts.appDb ? opts.appDb.open(parts.appDbMeta) : undefined;
  const sandbox = createSandbox({
    workerCode: parts.workerCode,
    env: parts.env,
    slug,
    agentConfig: parts.agentConfig,
    ...(db && { db }),
    ...(opts.pool && { pool: opts.pool }),
    ...(opts.defaultVector && { defaultVector: opts.defaultVector }),
    onVmFailed: () => {
      void withSlugLock(slug, async () => {
        const current = opts.slots.get(slug);
        if (current?.sandbox === sandbox) await terminateSlot(current);
      });
    },
  });
  return sandbox;
}

export async function resolveSandbox(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const { slots, store } = opts;

  // Fast path: a resident sandbox needs no locking.
  const resident = slots.get(slug);
  if (resident?.sandbox) return resident.sandbox as Sandbox;

  // Serialize per-slug so concurrent cold upgrades don't each spawn a
  // sandbox (duplicate Modal sandboxes, one orphaned) and so a session
  // never attaches a sandbox built from pre-deploy code while a deploy is
  // mutating the same slot (deploy/delete/secret all take this lock too).
  return withSlugLock(slug, async () => {
    let slot = slots.get(slug);
    if (slot?.sandbox) return slot.sandbox as Sandbox;

    // Kick off the bundle reads now so a cold miss doesn't serialize the
    // manifest read ahead of them (one extra storage RTT per
    // first-session-per-slug-per-replica). Each gets a no-op rejection
    // handler immediately: on a manifest miss the trio is discarded while
    // possibly still in flight, and a late rejection must not surface as an
    // unhandled rejection. `Promise.all` below still observes the originals.
    const workerCodeP = store.getWorkerCode(slug);
    const agentConfigP = store.getAgentConfig(slug);
    const envP = store.getEnv(slug).then((e) => e ?? {});
    // Storage ("app db") credentials, when the platform can open them.
    const appDbMetaP = readAppDbMeta(slug, opts);
    for (const p of [workerCodeP, agentConfigP, envP, appDbMetaP]) p.catch(() => undefined);

    if (!slot) {
      const manifest = await store.getManifest(slug);
      if (!manifest) return null;
      slot = {
        slug: manifest.slug,
        keyHash: manifest.credential_hashes[0] ?? "",
      };
      setSlot(slots, slot);
      debug("Lazy-discovered agent from store", { slug });
    }

    const [workerCode, agentConfig, env, appDbMeta] = await Promise.all([
      workerCodeP,
      agentConfigP,
      envP,
      appDbMetaP,
    ]);

    if (!(workerCode && agentConfig)) {
      return null;
    }

    const sandbox = buildSlotSandbox(slug, { workerCode, env, agentConfig, appDbMeta }, opts);

    attachSandbox(slots, slot, sandbox);
    return sandbox;
  });
}
