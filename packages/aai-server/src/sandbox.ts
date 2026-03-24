// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox using secure-exec V8 isolates.
 *
 * Each deployed agent runs inside a secure-exec isolate. The isolate loads
 * the agent bundle and exposes tool execution + lifecycle hooks over HTTP
 * on loopback. The host calls `createS2sSession` + `wireSessionSocket`
 * directly — no WintercServer or proxy AgentDef needed.
 *
 * A per-sandbox "capability server" on the host provides scoped KV and
 * vector access — the isolate calls it without authentication (loopback only).
 *
 * @module
 */

import http from "node:http";
import type { AgentConfig } from "@alexkroman1/aai/internal-types";
import type { KvEntry } from "@alexkroman1/aai/kv";
import { AUDIO_FORMAT } from "@alexkroman1/aai/protocol";
import { DEFAULT_S2S_CONFIG } from "@alexkroman1/aai/runtime";
import { createS2sSession, type HookInvoker, type Session } from "@alexkroman1/aai/session";
import type { ExecuteTool } from "@alexkroman1/aai/worker-entry";
import { wireSessionSocket } from "@alexkroman1/aai/ws-handler";
import {
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeRuntime,
} from "secure-exec";
import type { IsolateConfig } from "./_harness_protocol.ts";
import type { AgentMetadata } from "./_schemas.ts";
import type { DeployStore } from "./bundle_store_tigris.ts";
import type { KvStore } from "./kv.ts";
import { getHarnessRuntimeJs } from "./sandbox_harness.ts";
import type { AgentScope } from "./scope_token.ts";
import type { ServerVectorStore } from "./vector.ts";

export type { AgentMetadata } from "./_schemas.ts";

export type SandboxOptions = {
  workerCode: string;
  env: Record<string, string>;
  kvStore: KvStore;
  scope: AgentScope;
  vectorStore?: ServerVectorStore | undefined;
};

export type Sandbox = {
  startSession(socket: WebSocket, skipGreeting?: boolean): void;
  terminate(): void;
};

// ── Scoped store adapters (for capability server) ────────────────────────

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

// ── Capability server (per-sandbox, loopback, no auth) ───────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: route handlers use parsed JSON bodies
type CapRoute = (body: any) => Promise<unknown>;

function buildCapRoutes(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Record<string, CapRoute> {
  const requireVec = () => {
    if (!vector) throw Object.assign(new Error("Vector store not configured"), { status: 503 });
    return vector;
  };
  return {
    "/kv/get": (b) => kv.get(b.key),
    "/kv/set": async (b) => {
      await kv.set(b.key, b.value, b.options);
    },
    "/kv/del": async (b) => {
      await kv.delete(b.key);
    },
    "/kv/list": (b) => kv.list(b.prefix, { limit: b.limit, reverse: b.reverse }),
    "/kv/keys": (b) => kv.keys(b.pattern),
    "/vec/upsert": async (b) => {
      await requireVec().upsert(b.id, b.data, b.metadata);
    },
    "/vec/query": (b) => requireVec().query(b.text, { topK: b.topK, filter: b.filter }),
    "/vec/remove": async (b) => {
      await requireVec().remove(b.ids);
    },
  };
}

async function startCapabilityServer(
  kv: ReturnType<typeof scopedKv>,
  vector: ReturnType<typeof scopedVector> | undefined,
): Promise<{ url: string; close: () => void }> {
  const routes = buildCapRoutes(kv, vector);

  const server = http.createServer(async (req, res) => {
    try {
      const handler = routes[req.url ?? ""];
      if (!handler) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const body = JSON.parse(await readBody(req));
      const result = await handler(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result ?? null));
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  };
}

// ── Isolate lifecycle ────────────────────────────────────────────────────

async function startIsolate(
  workerCode: string,
  capUrl: string,
): Promise<{ port: number; runtime: NodeRuntime }> {
  const harnessJs = await getHarnessRuntimeJs();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  await fs.writeFile("/app/_harness_runtime.js", harnessJs);

  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: () => ({ allow: true }),
        network: () => ({ allow: true }),
      },
      useDefaultNetwork: true,
      processConfig: { env: { CAP_URL: capUrl } },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    onStdio(event) {
      if (event.channel === "stdout") {
        try {
          const data = JSON.parse(event.message);
          if (data.port) resolvePort(data.port);
        } catch {
          // Not the port announcement, ignore
        }
      }
    },
  });

  runtime.exec('import("/app/_harness_runtime.js")', { cwd: "/app" });

  const port = await portPromise;
  return { port, runtime };
}

async function getIsolateConfig(port: number): Promise<IsolateConfig> {
  const res = await fetch(`http://127.0.0.1:${port}/config`);
  if (!res.ok) throw new Error(`Isolate /config failed: ${res.status}`);
  return (await res.json()) as IsolateConfig;
}

// ── Build executeTool + hookInvoker from isolate ─────────────────────────

function buildExecuteTool(isolateUrl: string, env: Record<string, string>): ExecuteTool {
  return async (name, args, sessionId, messages) => {
    const res = await fetch(`${isolateUrl}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, sessionId, messages, env }),
    });
    if (!res.ok) throw new Error(`Tool ${name} failed: ${res.status}`);
    return ((await res.json()) as { result: string }).result;
  };
}

function buildHookInvoker(isolateUrl: string, env: Record<string, string>): HookInvoker {
  async function callHook(hook: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(`${isolateUrl}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook, env, ...extra }),
    });
    if (!res.ok) throw new Error(`Hook ${hook} failed: ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  }

  return {
    async onConnect(sessionId) {
      await callHook("onConnect", { sessionId });
    },
    async onDisconnect(sessionId) {
      await callHook("onDisconnect", { sessionId });
    },
    async onTurn(sessionId, text) {
      await callHook("onTurn", { sessionId, text });
    },
    async onError(sessionId, error) {
      await callHook("onError", { sessionId, error });
    },
    async onStep(sessionId, step) {
      await callHook("onStep", { sessionId, step });
    },
    async resolveTurnConfig(sessionId) {
      const r = await callHook("resolveTurnConfig", { sessionId });
      return r as { maxSteps?: number; activeTools?: string[] } | null;
    },
  };
}

function toAgentConfig(config: IsolateConfig): AgentConfig {
  return {
    name: config.name,
    instructions: config.instructions,
    greeting: config.greeting,
    ...(config.sttPrompt !== undefined ? { sttPrompt: config.sttPrompt } : {}),
    ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
    ...(config.toolChoice !== undefined ? { toolChoice: config.toolChoice } : {}),
    ...(config.builtinTools
      ? { builtinTools: config.builtinTools as AgentConfig["builtinTools"] }
      : {}),
    ...(config.activeTools ? { activeTools: config.activeTools } : {}),
  };
}

// ── Public API ───────────────────────────────────────────────────────────

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, env, kvStore, scope, vectorStore } = opts;

  const kv = scopedKv(kvStore, scope);
  const vector = vectorStore ? scopedVector(vectorStore, scope) : undefined;

  // 1. Start the per-sandbox capability server (KV/vector on loopback)
  const cap = await startCapabilityServer(kv, vector);

  // 2. Start the isolate with the agent bundle
  const { port: isolatePort, runtime } = await startIsolate(workerCode, cap.url);

  // 3. Get the agent config from the isolate
  const config = await getIsolateConfig(isolatePort);
  const isolateUrl = `http://127.0.0.1:${isolatePort}`;

  // 4. Build executeTool + hookInvoker that proxy to the isolate
  const agentConfig = toAgentConfig(config);
  const executeTool = buildExecuteTool(isolateUrl, env);
  const hookInvoker = buildHookInvoker(isolateUrl, env);
  const apiKey = env.ASSEMBLYAI_API_KEY ?? "";
  const s2sConfig = DEFAULT_S2S_CONFIG;

  const readyConfig = {
    audioFormat: AUDIO_FORMAT,
    sampleRate: s2sConfig.inputSampleRate,
    ttsSampleRate: s2sConfig.outputSampleRate,
  };

  const sessions = new Map<string, Session>();

  console.info("Sandbox initialized", { slug: scope.slug, isolatePort });

  return {
    startSession(socket: WebSocket, skipGreeting?: boolean): void {
      wireSessionSocket(socket as unknown as Parameters<typeof wireSessionSocket>[0], {
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
      cap.close();
    },
  };
}

// ── Agent slot lifecycle ─────────────────────────────────────────────────

const IDLE_MS = 5 * 60 * 1000;

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
  getEnv: () => Promise<Record<string, string>>;
};

async function spawnAgent(slot: AgentSlot, opts: EnsureOpts): Promise<void> {
  const { slug } = slot;
  console.info("Loading agent sandbox", { slug });

  const code = await opts.getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);

  slot.sandbox = await createSandbox({
    workerCode: code,
    env: await opts.getEnv(),
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
    store: DeployStore;
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
    getEnv: async () => (await opts.store.getEnv(slug)) ?? {},
  });
}
