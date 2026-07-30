// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox backed by gVisor OCI containers (Linux) or child processes
 * (macOS dev mode).
 *
 * The host runs `createRuntime()` with VM-backed `executeTool`, giving it
 * the same session/S2S/WebSocket handling as self-hosted mode without
 * duplicating any of that logic.
 *
 * Communication with the guest uses NDJSON over stdio pipes,
 * mediated by the `SandboxHandle` from `sandbox-vm.ts`.
 */

import { randomUUID } from "node:crypto";
import type { Kv } from "@alexkroman1/aai";
import {
  errorMessage,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  toolError,
} from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import {
  type AgentRuntime,
  createGenerateFn,
  createMemoryVector,
  createRuntime,
  createUnstorageKv,
  type ExecuteTool,
  type Runtime,
  resolveKv,
  resolveVector,
  safeFetch,
  type Vector,
} from "@alexkroman1/aai/runtime";
import { sendAllowedHosts } from "@alexkroman1/aai/send";
import type { Storage } from "unstorage";
import { debug } from "./_debug-log.ts";
import {
  createMessageDeltaTracker,
  isMessagesDesync,
  type MessagesDelta,
} from "./_sandbox-messages.ts";
import { agentKvPrefix, resolveHarnessPath } from "./constants.ts";
import { type IsolateConfig, ToolCallResponseSchema } from "./rpc-schemas.ts";
import { pipelineProviderOpts, toRuntimeAgent } from "./sandbox-agent-config.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { attachSandbox, setSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import { createSandboxVm } from "./sandbox-vm.ts";
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
  storage: Storage;
  slug: string;
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfig;
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

/**
 * Handler for guest→client `client/send` notifications: validates the
 * envelope, enforces the payload byte cap, and relays to the session's sink.
 *
 * The payload cap is measured in UTF-8 bytes (`Buffer.byteLength`), matching
 * what actually goes over the WebSocket — `.length` counts UTF-16 code units
 * and undercounts multibyte text. The serialized string exists only for that
 * size check: `ClientSink.event` takes the event object and owns the final
 * envelope serialization (there is no pre-serialized variant of the API), so
 * this is the single stringify on the aai-server side and `data` passes
 * through untouched. The sink lookup runs first so events for unknown or
 * closed sessions never pay the serialization at all.
 *
 * Exported for unit tests.
 */
export function createClientSendHandler(sessionSinks: Map<string, ClientSink>) {
  return (raw: unknown): void => {
    const params = raw as { sessionId: string; event: string; data: unknown };
    if (typeof params.sessionId !== "string" || typeof params.event !== "string") return;
    if (params.event.length > MAX_CLIENT_EVENT_NAME_LENGTH) return;
    const sink = sessionSinks.get(params.sessionId);
    if (!sink?.open) return;
    // `data` may be undefined (event sent with no payload) — JSON.stringify
    // returns undefined for it, so guard before measuring.
    const serializedData = JSON.stringify(params.data ?? null);
    if (Buffer.byteLength(serializedData) > MAX_CLIENT_EVENT_PAYLOAD_BYTES) return;
    sink.event({ type: "custom_event", event: params.event, data: params.data });
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Resolve the KV store an agent gets: its declared `kv:` provider (BYO,
 * resolved with the agent's env) or the platform default (unstorage,
 * prefixed per slug). Single source of truth for the sandbox and the
 * owner HTTP KV routes.
 */
export function resolveAgentKv(
  storage: Storage,
  slug: string,
  config: Pick<IsolateConfig, "kv"> | null,
  env: Record<string, string>,
): Kv {
  return config?.kv
    ? resolveKv(config.kv, env, agentKvPrefix(slug))
    : createUnstorageKv({ storage, prefix: agentKvPrefix(slug) });
}

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
  const { workerCode, env, storage, slug } = opts;

  const config = opts.agentConfig;

  const harnessPath = resolveHarnessPath();

  const kv: Kv = resolveAgentKv(storage, slug, config, env);
  const vector: Vector = resolveAgentVector(slug, config, env, opts.defaultVector);

  const vmReady = createSandboxVm(
    {
      slug,
      workerCode,
      env,
      kv,
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
    toolSchemas: config.toolSchemas,
    // The SDK's SSRF-protected fetch (also the default inside
    // resolveAllBuiltins) — passed explicitly so the platform's egress policy
    // is visible here rather than only implied by a default.
    fetch: safeFetch,
    ...pipelineProviderOpts(config),
  });

  const sessionSinks = new Map<string, ClientSink>();

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
    try {
      const handle = await vmReady;
      await handle.shutdown();
    } catch {
      // VM failed to start or already shut down
    }
    await agentRuntime.shutdown();
  }

  const originalStartSession = agentRuntime.startSession.bind(agentRuntime);
  function startSessionWithCleanup(
    ws: Parameters<typeof originalStartSession>[0],
    opts?: Parameters<typeof originalStartSession>[1],
  ): void {
    originalStartSession(ws, {
      ...opts,
      onSinkCreated(sessionId, sink) {
        sessionSinks.set(sessionId, sink);
        opts?.onSinkCreated?.(sessionId, sink);
      },
      onSessionEnd(sessionId) {
        sessionSinks.delete(sessionId);
        messageTracker.reset(sessionId);
        vmReady
          .then((handle) => handle.conn.sendNotification("session/end", { sessionId }))
          .catch(() => {
            // VM failed to start — session/end notification is best-effort
          });
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

export async function resolveSandbox(
  slug: string,
  opts: {
    slots: import("./sandbox-slots.ts").SlotCache;
    store: BundleStore;
    storage: Storage;
    pool?: SandboxPool;
    defaultVector?: (slug: string) => Vector;
  },
): Promise<Sandbox | null> {
  const { slots, store, storage, pool } = opts;

  // Fast path: a resident sandbox needs no locking.
  const resident = slots.get(slug);
  if (resident?.sandbox) return resident.sandbox as Sandbox;

  // Serialize per-slug so concurrent cold upgrades don't each spawn a
  // sandbox (duplicate gVisor containers, one orphaned) and so a session
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
    for (const p of [workerCodeP, agentConfigP, envP]) p.catch(() => undefined);

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

    const [workerCode, agentConfig, env] = await Promise.all([workerCodeP, agentConfigP, envP]);

    if (!(workerCode && agentConfig)) {
      return null;
    }

    const sandbox = createSandbox({
      workerCode,
      env,
      storage,
      slug,
      agentConfig,
      ...(pool && { pool }),
      ...(opts.defaultVector && { defaultVector: opts.defaultVector }),
      // A rejected vmReady leaves this sandbox permanently broken (every tool
      // call fails) while live traffic keeps clearing its idle timer, so it
      // would never self-heal. Detach it so the next connection rebuilds —
      // identity-checked and under the slug lock so a deploy/delete that
      // already replaced the slot is never raced. (createSandbox returns
      // synchronously and attachSandbox below runs in the same task, so the
      // async failure callback can only fire after the attach.)
      onVmFailed: () => {
        void withSlugLock(slug, async () => {
          const current = slots.get(slug);
          if (current?.sandbox === sandbox) await terminateSlot(current);
        });
      },
    });

    attachSandbox(slots, slot, sandbox);
    return sandbox;
  });
}
