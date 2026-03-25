// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox using secure-exec V8 isolates.
 *
 * Each deployed agent runs inside a secure-exec isolate. The isolate loads
 * the agent bundle and exposes tool execution + lifecycle hooks over HTTP
 * on loopback. The host calls `createS2sSession` + `wireSessionSocket`
 * directly — no WintercServer or proxy AgentDef needed.
 *
 * A per-sandbox sidecar server on the host provides scoped KV and
 * vector access — the isolate calls it without authentication (loopback only).
 */

import type { AgentConfig } from "@alexkroman1/aai/internal-types";
import type { Kv, KvEntry } from "@alexkroman1/aai/kv";
import { buildReadyConfig } from "@alexkroman1/aai/protocol";
import { DEFAULT_S2S_CONFIG } from "@alexkroman1/aai/runtime";
import { createS2sSession, type HookInvoker, type Session } from "@alexkroman1/aai/session";
import type { VectorStore } from "@alexkroman1/aai/vector";
import type { ExecuteTool } from "@alexkroman1/aai/worker-entry";
import { type SessionWebSocket, wireSessionSocket } from "@alexkroman1/aai/ws-handler";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createDefaultNetworkAdapter,
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeRuntime,
} from "secure-exec";
import { z } from "zod";
import {
  HookResponseSchema,
  type IsolateConfig,
  IsolateConfigSchema,
  ToolCallResponseSchema,
  TurnConfigResultSchema,
} from "./_harness-protocol.ts";
import type { AgentMetadata } from "./_schemas.ts";
import type { BundleStore } from "./bundle-store-tigris.ts";
import type { KvStore } from "./kv.ts";
import { getHarnessRuntimeJs } from "./sandbox-harness.ts";
import type { AgentScope } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

export type { AgentMetadata } from "./_schemas.ts";

export type SandboxOptions = {
  workerCode: string;
  /** Platform API key (e.g. AssemblyAI) — used by the host only, never sent to the isolate. */
  apiKey: string;
  /** Agent-defined secrets — forwarded to the isolate via AAI_ENV_ prefixed process env. */
  agentEnv: Record<string, string>;
  kvStore: KvStore;
  scope: AgentScope;
  vectorStore?: ServerVectorStore | undefined;
};

export type Sandbox = {
  startSession(socket: SessionWebSocket, skipGreeting?: boolean): void;
  terminate(): void;
};

// ── Scoped store adapters (for sidecar server) ──────────────────────────

function scopedKv(kvStore: KvStore, scope: AgentScope) {
  return {
    async get(key: string) {
      const raw = await kvStore.get(scope, key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }) {
      const ttl = options?.expireIn ? Math.ceil(options.expireIn / 1000) : undefined;
      await kvStore.set(scope, key, JSON.stringify(value), ttl);
    },
    async delete(key: string) {
      await kvStore.del(scope, key);
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<KvEntry<T>[]> {
      return (await kvStore.list(scope, prefix, options ?? {})) as KvEntry<T>[];
    },
    async keys(pattern?: string) {
      return await kvStore.keys(scope, pattern);
    },
  };
}

// Compile-time checks: scoped adapters must satisfy the SDK interfaces.
// If Kv or VectorStore gain a method, these lines will error until implemented.
null as unknown as ReturnType<typeof scopedKv> satisfies Kv;
null as unknown as ReturnType<typeof scopedVector> satisfies VectorStore;

function scopedVector(vectorStore: ServerVectorStore, scope: AgentScope) {
  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>) {
      await vectorStore.upsert(scope, id, data, metadata);
    },
    async query(text: string, options?: { topK?: number; filter?: string }) {
      return await vectorStore.query(scope, text, options?.topK, options?.filter);
    },
    async remove(ids: string | string[]) {
      await vectorStore.remove(scope, Array.isArray(ids) ? ids : [ids]);
    },
  };
}

// ── Sidecar request schemas (per-endpoint, loopback only) ───────────────

const SidecarKvGetSchema = z.object({ key: z.string() });
const SidecarKvSetSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  options: z.object({ expireIn: z.number().optional() }).optional(),
});
const SidecarKvDelSchema = z.object({ key: z.string() });
const SidecarKvListSchema = z.object({
  prefix: z.string(),
  limit: z.number().optional(),
  reverse: z.boolean().optional(),
});
const SidecarKvKeysSchema = z.object({ pattern: z.string().optional() });
const SidecarVecUpsertSchema = z.object({
  id: z.string(),
  data: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const SidecarVecQuerySchema = z.object({
  text: z.string(),
  topK: z.number().optional(),
  filter: z.string().optional(),
});
const SidecarVecRemoveSchema = z.object({ ids: z.union([z.string(), z.array(z.string())]) });

// ── Sidecar server (per-sandbox, loopback, no auth) ─────────────────────

function buildSidecarApp(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Hono {
  const app = new Hono();

  const requireVec = () => {
    if (!vector) throw Object.assign(new Error("Vector store not configured"), { status: 503 });
    return vector;
  };

  app.post("/kv/get", async (c) => {
    const { key } = SidecarKvGetSchema.parse(await c.req.json());
    return c.json((await kv.get(key)) ?? null);
  });
  app.post("/kv/set", async (c) => {
    const { key, value, options } = SidecarKvSetSchema.parse(await c.req.json());
    await kv.set(
      key,
      value,
      options?.expireIn != null ? { expireIn: options.expireIn } : undefined,
    );
    return c.json(null);
  });
  app.post("/kv/del", async (c) => {
    const { key } = SidecarKvDelSchema.parse(await c.req.json());
    await kv.delete(key);
    return c.json(null);
  });
  app.post("/kv/list", async (c) => {
    const { prefix, limit, reverse } = SidecarKvListSchema.parse(await c.req.json());
    return c.json(
      await kv.list(prefix, {
        ...(limit != null && { limit }),
        ...(reverse != null && { reverse }),
      }),
    );
  });
  app.post("/kv/keys", async (c) => {
    const { pattern } = SidecarKvKeysSchema.parse(await c.req.json());
    return c.json(await kv.keys(pattern));
  });
  app.post("/vec/upsert", async (c) => {
    const { id, data, metadata } = SidecarVecUpsertSchema.parse(await c.req.json());
    await requireVec().upsert(id, data, metadata);
    return c.json(null);
  });
  app.post("/vec/query", async (c) => {
    const { text, topK, filter } = SidecarVecQuerySchema.parse(await c.req.json());
    return c.json(
      await requireVec().query(text, {
        ...(topK != null && { topK }),
        ...(filter != null && { filter }),
      }),
    );
  });
  app.post("/vec/remove", async (c) => {
    const { ids } = SidecarVecRemoveSchema.parse(await c.req.json());
    await requireVec().remove(ids);
    return c.json(null);
  });

  app.onError((err, c) => {
    const isValidation = err.name === "ZodError";
    const status = (
      isValidation ? 400 : ((err as { status?: number }).status ?? 500)
    ) as import("hono/utils/http-status").ContentfulStatusCode;
    return c.json({ error: err.message }, status);
  });

  return app;
}

async function startSidecarServer(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Promise<{ url: string; close: () => void }> {
  const app = buildSidecarApp(kv, vector);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

  await new Promise<void>((resolve) => {
    server.on("listening", resolve);
  });

  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  };
}

// ── Isolate network policy ────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const SidecarUrlSchema = z
  .string()
  .url()
  .refine((u) => LOOPBACK_HOSTS.has(new URL(u).hostname), "Sidecar server must be on loopback");

/**
 * Build a network permission check that restricts the isolate to:
 *   1. Listening on loopback (its own harness HTTP server)
 *   2. DNS lookups for loopback hostnames only
 *   3. fetch/http to the sidecar server URL only
 *
 * Everything else (cloud metadata, internal services, external hosts) is denied.
 */
function buildNetworkPolicy(sidecarUrl: string) {
  const parsed = new URL(SidecarUrlSchema.parse(sidecarUrl));
  const allowedHost = parsed.hostname;
  const allowedPort = parsed.port;

  const AllowedRequestSchema = z.object({
    url: z
      .string()
      .url()
      .refine((u) => {
        const t = new URL(u);
        return t.hostname === allowedHost && t.port === allowedPort;
      }, "URL must target the sidecar server"),
  });

  return (req: { op: string; url?: string; hostname?: string }) => {
    if (req.op === "listen") return { allow: true };
    if (req.op === "dns") {
      return LOOPBACK_HOSTS.has(req.hostname ?? "")
        ? { allow: true }
        : { allow: false, reason: "DNS lookups restricted to loopback" };
    }
    const result = AllowedRequestSchema.safeParse(req);
    return result.success
      ? { allow: true }
      : { allow: false, reason: "Network restricted to sidecar server" };
  };
}

/**
 * Build a network adapter that wraps the default but exempts the sidecar
 * URL from SSRF checks. The default adapter blocks all private IPs (including
 * 127.0.0.1), but the isolate needs to reach the sidecar on loopback.
 */
function buildNetworkAdapter(sidecarUrl: string) {
  const defaultAdapter = createDefaultNetworkAdapter();
  const sidecarOrigin = new URL(sidecarUrl).origin;

  return {
    ...defaultAdapter,
    async fetch(
      url: string,
      options: { method?: string; headers?: Record<string, string>; body?: string | null },
    ) {
      // Sidecar calls bypass SSRF — they're our own capability server on loopback
      if (url.startsWith(sidecarOrigin)) {
        const res = await globalThis.fetch(url, {
          method: options.method ?? "GET",
          ...(options.headers != null && { headers: options.headers }),
          ...(options.body !== undefined && { body: options.body }),
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers,
          body: await res.text(),
          url: res.url,
          redirected: res.redirected,
        };
      }
      // Everything else goes through the default adapter (with SSRF checks)
      return defaultAdapter.fetch(url, options);
    },
  };
}

// ── Isolate lifecycle ────────────────────────────────────────────────────

async function startIsolate(
  workerCode: string,
  sidecarUrl: string,
  agentEnv: Record<string, string>,
): Promise<{ port: number; runtime: NodeRuntime }> {
  const harnessJs = await getHarnessRuntimeJs();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  await fs.writeFile("/app/_harness-runtime.js", harnessJs);

  // Prefix agent env vars so they can be distinguished from system vars.
  // The harness reads AAI_ENV_* and strips the prefix to build ctx.env.
  const prefixedEnv: Record<string, string> = { SIDECAR_URL: sidecarUrl };
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));

  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req) =>
          req.op === "read" || req.op === "stat" || req.op === "readdir" || req.op === "exists"
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: buildNetworkPolicy(sidecarUrl),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: (req) =>
          req.op === "read" && allowedKeys.has(req.key ?? "")
            ? { allow: true }
            : { allow: false, reason: "Env access restricted" },
      },
      networkAdapter: buildNetworkAdapter(sidecarUrl),
      processConfig: {
        env: prefixedEnv,
        timingMitigation: "freeze",
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    onStdio(event) {
      if (event.channel === "stdout") {
        try {
          const parsed = z.object({ port: z.number() }).safeParse(JSON.parse(event.message));
          if (parsed.success) resolvePort(parsed.data.port);
        } catch {
          // Not the port announcement, ignore
        }
      }
      if (event.channel === "stderr") {
        console.error("[isolate stderr]", event.message);
      }
    },
  });

  runtime.exec(
    'import agent from "/app/agent_bundle.js";\nimport { startHarness } from "/app/_harness-runtime.js";\nstartHarness(agent);',
    { cwd: "/app" },
  );

  const port = await portPromise;
  return { port, runtime };
}

// ── Isolate response schemas (validated on the host, not in the isolate) ──
// Annotated with z.ZodType<IsolateConfig> to enforce parity with the type
// definition in _harness-protocol.ts at compile time.

// RPC schemas are defined in _harness-protocol.ts (single source of truth).
// IsolateConfigSchema, ToolCallResponseSchema, HookResponseSchema,
// TurnConfigResultSchema are imported above.

// ── Isolate RPC timeouts ─────────────────────────────────────────────────

/** Timeout for initial config fetch (isolate boot). */
const CONFIG_TIMEOUT_MS = 10_000;
/** Timeout for tool execution calls. */
const TOOL_TIMEOUT_MS = 30_000;
/** Timeout for lifecycle hook calls. */
const HOOK_TIMEOUT_MS = 10_000;

// ── Isolate config fetch ─────────────────────────────────────────────────

async function getIsolateConfig(port: number): Promise<IsolateConfig> {
  const res = await fetch(`http://127.0.0.1:${port}/config`, {
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Isolate /config failed: ${res.status}`);
  return IsolateConfigSchema.parse(await res.json()) as IsolateConfig;
}

// ── Build executeTool + hookInvoker from isolate ─────────────────────────

async function callIsolate<T>(
  isolateUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await fetch(`${isolateUrl}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
  return schema.parse(await res.json());
}

function buildExecuteTool(isolateUrl: string): ExecuteTool {
  return async (name, args, sessionId, messages) => {
    const { result } = await callIsolate(
      isolateUrl,
      "tool",
      { name, args, sessionId, messages },
      TOOL_TIMEOUT_MS,
      ToolCallResponseSchema,
    );
    return result;
  };
}

function buildHookInvoker(isolateUrl: string): HookInvoker {
  const hook = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    (
      await callIsolate(
        isolateUrl,
        "hook",
        { hook: name, ...extra },
        HOOK_TIMEOUT_MS,
        HookResponseSchema,
      )
    ).result;

  return {
    onConnect: (sessionId) => hook("onConnect", { sessionId }) as Promise<void>,
    onDisconnect: (sessionId) => hook("onDisconnect", { sessionId }) as Promise<void>,
    onTurn: (sessionId, text) => hook("onTurn", { sessionId, text }) as Promise<void>,
    onError: (sessionId, error) => hook("onError", { sessionId, error }) as Promise<void>,
    onStep: (sessionId, step) => hook("onStep", { sessionId, step }) as Promise<void>,
    async resolveTurnConfig(sessionId) {
      const parsed = TurnConfigResultSchema.parse(await hook("resolveTurnConfig", { sessionId }));
      if (parsed == null) return null;
      const config: { maxSteps?: number; activeTools?: string[] } = {};
      if (parsed.maxSteps != null) config.maxSteps = parsed.maxSteps;
      if (parsed.activeTools != null) config.activeTools = parsed.activeTools;
      return config;
    },
  };
}

function toAgentConfig(config: IsolateConfig): AgentConfig {
  const ac: AgentConfig = {
    name: config.name,
    instructions: config.instructions,
    greeting: config.greeting,
  };
  if (config.sttPrompt !== undefined) ac.sttPrompt = config.sttPrompt;
  if (config.maxSteps !== undefined) ac.maxSteps = config.maxSteps;
  if (config.toolChoice !== undefined) ac.toolChoice = config.toolChoice;
  if (config.builtinTools) ac.builtinTools = config.builtinTools as AgentConfig["builtinTools"];
  if (config.activeTools) ac.activeTools = config.activeTools;
  return ac;
}

// ── Test internals ───────────────────────────────────────────────────────

export const _internals = {
  startSidecarServer,
  startIsolate,
  getIsolateConfig,
  buildNetworkPolicy,
  createSandbox,
  get IDLE_MS() {
    return IDLE_MS;
  },
  set IDLE_MS(ms: number) {
    IDLE_MS = ms;
  },
};

// ── Public API ───────────────────────────────────────────────────────────

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, apiKey, agentEnv, kvStore, scope, vectorStore } = opts;

  const kv = scopedKv(kvStore, scope);
  const vector = vectorStore ? scopedVector(vectorStore, scope) : undefined;

  // 1. Start the per-sandbox sidecar server (KV/vector on loopback)
  const sidecar = await startSidecarServer(kv, vector);

  // 2. Start the isolate with the agent bundle
  //    Only agent-defined secrets enter the isolate; apiKey stays host-side.
  const { port: isolatePort, runtime } = await startIsolate(workerCode, sidecar.url, agentEnv);

  // 3. Get the agent config from the isolate
  const config = await getIsolateConfig(isolatePort);
  const isolateUrl = `http://127.0.0.1:${isolatePort}`;

  // 4. Build executeTool + hookInvoker that proxy to the isolate
  //    env is no longer sent per-request — it lives inside the isolate
  const agentConfig = toAgentConfig(config);
  const executeTool = buildExecuteTool(isolateUrl);
  const hookInvoker = buildHookInvoker(isolateUrl);
  const s2sConfig = DEFAULT_S2S_CONFIG;
  const readyConfig = buildReadyConfig(s2sConfig);

  const sessions = new Map<string, Session>();

  console.info("Sandbox initialized", { slug: scope.slug, isolatePort });

  return {
    startSession(socket: SessionWebSocket, skipGreeting?: boolean): void {
      wireSessionSocket(socket, {
        sessions,
        createSession: (sid, client) =>
          createS2sSession({
            id: sid,
            agent: agentConfig.name,
            client,
            agentConfig,
            toolSchemas: config.toolSchemas,
            apiKey,
            s2sConfig,
            executeTool,
            hookInvoker,
            skipGreeting: skipGreeting ?? false,
          }),
        readyConfig,
      });
    },
    terminate(): void {
      for (const session of sessions.values()) {
        void session.stop();
      }
      sessions.clear();
      runtime.dispose();
      sidecar.close();
    },
  };
}

// ── Agent slot lifecycle ─────────────────────────────────────────────────

let IDLE_MS = 5 * 60 * 1000;

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: Sandbox;
  initializing?: Promise<Sandbox>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type EnsureOpts = {
  getWorkerCode: (slug: string) => Promise<string | null>;
  kvCtx: { kvStore: KvStore; scope: AgentScope };
  vectorCtx?: { vectorStore: ServerVectorStore; scope: AgentScope } | undefined;
  /** Platform API key (e.g. AssemblyAI) — host-only, never enters the isolate. */
  getApiKey: () => Promise<string>;
  /** Agent-defined secrets — forwarded to the isolate. */
  getAgentEnv: () => Promise<Record<string, string>>;
};

async function spawnAgent(slot: AgentSlot, opts: EnsureOpts): Promise<void> {
  const { slug } = slot;
  console.info("Loading agent sandbox", { slug });

  const code = await opts.getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);

  const [apiKey, agentEnv] = await Promise.all([opts.getApiKey(), opts.getAgentEnv()]);
  slot.sandbox = await createSandbox({
    workerCode: code,
    apiKey,
    agentEnv,
    kvStore: opts.kvCtx.kvStore,
    scope: opts.kvCtx.scope,
    vectorStore: opts.vectorCtx?.vectorStore,
  });
}

function resetIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (!slot.sandbox) return;
    console.info("Evicting idle sandbox", { slug: slot.slug });
    slot.sandbox.terminate();
    delete slot.sandbox;
    delete slot.idleTimer;
  }, IDLE_MS);
}

export function ensureAgent(slot: AgentSlot, opts: EnsureOpts): Promise<Sandbox> {
  const t0 = performance.now();

  if (slot.sandbox) {
    resetIdleTimer(slot);
    return Promise.resolve(slot.sandbox);
  }
  if (slot.initializing) return slot.initializing;

  slot.initializing = spawnAgent(slot, opts)
    .then(() => {
      delete slot.initializing;
      resetIdleTimer(slot);
      console.info("Agent sandbox ready", {
        slug: slot.slug,
        durationMs: Math.round(performance.now() - t0),
      });
      // biome-ignore lint/style/noNonNullAssertion: sandbox is set by spawnAgent above
      return slot.sandbox!;
    })
    .catch((err) => {
      delete slot.initializing;
      throw err;
    });

  return slot.initializing;
}

export function registerSlot(slots: Map<string, AgentSlot>, metadata: AgentMetadata): void {
  slots.set(metadata.slug, {
    slug: metadata.slug,
    keyHash: metadata.credential_hashes[0] ?? "",
  });
}

export async function resolveSandbox(
  slug: string,
  opts: {
    slots: Map<string, AgentSlot>;
    store: BundleStore;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;
  },
): Promise<Sandbox | null> {
  let slot = opts.slots.get(slug);

  if (!slot) {
    const manifest = await opts.store.getManifest(slug);
    if (!manifest) return null;
    registerSlot(opts.slots, manifest);
    // biome-ignore lint/style/noNonNullAssertion: just registered above
    slot = opts.slots.get(slug)!;
    console.info("Lazy-discovered agent from store", { slug });
  }

  const scope = { keyHash: slot.keyHash, slug };

  return await ensureAgent(slot, {
    getWorkerCode: (s: string) => opts.store.getWorkerCode(s),
    kvCtx: { kvStore: opts.kvStore, scope },
    vectorCtx: opts.vectorStore ? { vectorStore: opts.vectorStore, scope } : undefined,
    getApiKey: async () => {
      const env = await opts.store.getEnv(slug);
      return env?.ASSEMBLYAI_API_KEY ?? "";
    },
    getAgentEnv: async () => {
      const env = await opts.store.getEnv(slug);
      if (!env) return {};
      // Only forward agent-defined secrets; platform keys stay host-side
      const { ASSEMBLYAI_API_KEY: _, ...agentEnv } = env;
      return agentEnv;
    },
  });
}
