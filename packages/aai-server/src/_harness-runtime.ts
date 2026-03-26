// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness runtime — runs inside the secure-exec isolate.
 *
 * This file is type-checked at compile time against the shared protocol
 * types and AgentDef. At runtime, the compiled JS is loaded into the
 * isolate's virtual filesystem and executed.
 *
 * Environment variables (set by host):
 * - SIDECAR_URL: loopback URL for the per-sandbox sidecar server
 * - SIDECAR_TOKEN: bearer token for authenticating to the sidecar
 *
 * The agent bundle is expected at "./agent_bundle.js" (default export).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef, HookContext, Middleware, ToolContext } from "@alexkroman1/aai/types";
import type { VectorStore } from "@alexkroman1/aai/vector";
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness-protocol.ts";

const SIDECAR_URL = process.env.SIDECAR_URL ?? "";
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN ?? "";

/**
 * Read agent env vars from process.env once at startup.
 * The host passes them with an AAI_ENV_ prefix; we strip the prefix
 * so tools/hooks see the original key names (e.g. ASSEMBLYAI_API_KEY).
 * This avoids sending secrets over the wire on every RPC call.
 */
const AAI_ENV_PREFIX = "AAI_ENV_";
const agentEnv: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
      .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
  ),
);

// ── Sidecar server proxy (KV / vector) ───────────────────────────────────

async function sidecarRpc<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SIDECAR_TOKEN) headers.Authorization = `Bearer ${SIDECAR_TOKEN}`;
  const res = await fetch(`${SIDECAR_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (null as T);
}

const kv: Kv = {
  get<T = unknown>(key: string) {
    return sidecarRpc<T | null>("/kv/get", { key });
  },
  set(key: string, value: unknown, options?: { expireIn?: number }) {
    return sidecarRpc<void>("/kv/set", { key, value, options });
  },
  delete(keys: string | string[]) {
    return sidecarRpc<void>("/kv/del", { key: keys });
  },
  list<T = unknown>(prefix: string, options?: { limit?: number; reverse?: boolean }) {
    return sidecarRpc<{ key: string; value: T }[]>("/kv/list", { prefix, ...options });
  },
  keys(pattern?: string) {
    return sidecarRpc<string[]>("/kv/keys", { pattern });
  },
};

const vector: VectorStore = {
  upsert(id: string, data: string, metadata?: Record<string, unknown>) {
    return sidecarRpc<void>("/vec/upsert", { id, data, metadata });
  },
  query(text: string, options?: { topK?: number; filter?: string }) {
    return sidecarRpc("/vec/query", { text, ...options });
  },
  remove(ids: string | string[]) {
    return sidecarRpc<void>("/vec/remove", { ids: Array.isArray(ids) ? ids : [ids] });
  },
};

// ── Per-session state ────────────────────────────────────────────────────

const sessionStates = new Map<string, Record<string, unknown>>();

function getState(agent: AgentDef, sessionId: string): Record<string, unknown> {
  if (!sessionStates.has(sessionId) && agent.state) {
    sessionStates.set(sessionId, agent.state());
  }
  return sessionStates.get(sessionId) ?? {};
}

// ── Tool schemas ─────────────────────────────────────────────────────────

function extractToolSchemas(agent: AgentDef): IsolateConfig["toolSchemas"] {
  return Object.entries(agent.tools).map(([name, def]) => ({
    name,
    description: def.description,
    parameters:
      def.parameters && "toJSON" in def.parameters && typeof def.parameters.toJSON === "function"
        ? (def.parameters.toJSON() as Record<string, unknown>)
        : ({ type: "object", properties: {} } as Record<string, unknown>),
  }));
}

// ── Config extraction ────────────────────────────────────────────────────

function extractConfig(agent: AgentDef): IsolateConfig {
  const config: IsolateConfig = {
    name: agent.name,
    instructions: agent.instructions,
    greeting: agent.greeting,
    toolSchemas: extractToolSchemas(agent),
    hasState: typeof agent.state === "function",
    hooks: {
      onConnect: typeof agent.onConnect === "function",
      onDisconnect: typeof agent.onDisconnect === "function",
      onError: typeof agent.onError === "function",
      onTurn: typeof agent.onTurn === "function",
      onStep: typeof agent.onStep === "function",
      onBeforeStep: typeof agent.onBeforeStep === "function",
      maxStepsIsFn: typeof agent.maxSteps === "function",
      hasMiddleware: Array.isArray(agent.middleware) && agent.middleware.length > 0,
    },
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
  if (agent.activeTools) config.activeTools = [...agent.activeTools];
  return config;
}

// ── Tool execution ───────────────────────────────────────────────────────

/**
 * Timeout for tool execution inside the isolate. Set slightly under the
 * host's TOOL_TIMEOUT_MS (30 s) so the isolate returns a clean error
 * before the host-side timeout fires.
 */
const ISOLATE_TOOL_TIMEOUT_MS = 25_000;

async function executeTool(agent: AgentDef, req: ToolCallRequest): Promise<ToolCallResponse> {
  const tool = agent.tools[req.name];
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${req.name}`), { status: 404 });

  const ctx: ToolContext = {
    env: agentEnv,
    state: getState(agent, req.sessionId),
    kv,
    vector,
    messages: req.messages,
  };

  const parsed =
    tool.parameters && typeof tool.parameters.parse === "function"
      ? tool.parameters.parse(req.args)
      : req.args;

  const result = await Promise.race([
    tool.execute(parsed, ctx),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Tool "${req.name}" timed out after ${ISOLATE_TOOL_TIMEOUT_MS}ms`)),
        ISOLATE_TOOL_TIMEOUT_MS,
      );
    }),
  ]);
  return {
    result: typeof result === "string" ? result : JSON.stringify(result),
    state: ctx.state,
  };
}

// ── Hook invocation ──────────────────────────────────────────────────────

function makeHookCtx(agent: AgentDef, req: HookRequest): HookContext {
  return {
    env: agentEnv,
    state: getState(agent, req.sessionId),
    kv,
    vector,
  };
}

async function runResolveTurnConfig(
  agent: AgentDef,
  ctx: HookContext,
  stepNumber: number,
): Promise<{ maxSteps?: number; activeTools?: string[] } | null> {
  const config: { maxSteps?: number; activeTools?: string[] } = {};
  if (typeof agent.maxSteps === "function") {
    config.maxSteps = (await agent.maxSteps(ctx)) ?? undefined;
  }
  if (agent.onBeforeStep) {
    const r = await agent.onBeforeStep(stepNumber, ctx);
    if (r?.activeTools) config.activeTools = r.activeTools;
  }
  return config.maxSteps !== undefined || config.activeTools !== undefined ? config : null;
}

// ── Middleware runner (inline — cannot import from middleware.ts in isolate) ──

async function runMiddlewareBeforeTurn(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<string | undefined> {
  for (const mw of middleware) {
    if (!mw.beforeTurn) continue;
    const r = await mw.beforeTurn(text, ctx);
    if (r && "block" in r && r.block) return r.reason;
  }
}

async function runMiddlewareAfterTurn(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.afterTurn) await mw.afterTurn(text, ctx);
  }
}

async function runMiddlewareToolIntercept(
  middleware: readonly Middleware[],
  toolName: string,
  args: Record<string, unknown>,
  ctx: HookContext,
): Promise<unknown> {
  let currentArgs = args;
  for (const mw of middleware) {
    if (!mw.toolCallInterceptor) continue;
    const r = await mw.toolCallInterceptor(toolName, currentArgs, ctx);
    if (!r) continue;
    if ("block" in r && r.block) return { type: "block", reason: r.reason };
    if ("result" in r) return { type: "result", result: r.result };
    if ("args" in r) currentArgs = r.args;
  }
  if (currentArgs !== args) return { type: "args", args: currentArgs };
}

async function runMiddlewareAfterToolCall(
  middleware: readonly Middleware[],
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  ctx: HookContext,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.afterToolCall) await mw.afterToolCall(toolName, args, result, ctx);
  }
}

async function runMiddlewareOutputFilter(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<string> {
  let filtered = text;
  for (const mw of middleware) {
    if (mw.outputFilter) filtered = await mw.outputFilter(filtered, ctx);
  }
  return filtered;
}

async function invokeHook(agent: AgentDef, req: HookRequest): Promise<HookResponse> {
  const ctx = makeHookCtx(agent, req);
  let result: unknown;
  const middleware: readonly Middleware[] = agent.middleware ?? [];

  const handlers: Record<string, () => Promise<void> | void> = {
    onConnect: () => agent.onConnect?.(ctx),
    onDisconnect: async () => {
      await agent.onDisconnect?.(ctx);
      sessionStates.delete(req.sessionId);
    },
    onTurn: () => agent.onTurn?.(req.text ?? "", ctx),
    onError: () => agent.onError?.(new Error(req.error?.message ?? "Unknown error"), ctx),
    onStep: () => {
      if (req.step) return agent.onStep?.(req.step, ctx);
    },
    onBeforeStep: async () => {
      result = await agent.onBeforeStep?.(req.stepNumber ?? 0, ctx);
    },
    resolveTurnConfig: async () => {
      result = await runResolveTurnConfig(agent, ctx, req.stepNumber ?? 0);
    },
    // Middleware hooks
    beforeTurn: async () => {
      result = await runMiddlewareBeforeTurn(middleware, req.text ?? "", ctx);
    },
    afterTurn: async () => {
      await runMiddlewareAfterTurn(middleware, req.text ?? "", ctx);
    },
    interceptToolCall: async () => {
      result = await runMiddlewareToolIntercept(
        middleware,
        req.step?.toolCalls[0]?.toolName ?? "",
        (req.step?.toolCalls[0]?.args as Record<string, unknown>) ?? {},
        ctx,
      );
    },
    afterToolCall: async () => {
      await runMiddlewareAfterToolCall(
        middleware,
        req.step?.toolCalls[0]?.toolName ?? "",
        (req.step?.toolCalls[0]?.args as Record<string, unknown>) ?? {},
        req.text ?? "",
        ctx,
      );
    },
    filterOutput: async () => {
      result = await runMiddlewareOutputFilter(middleware, req.text ?? "", ctx);
    },
  };

  const handler = handlers[req.hook];
  if (handler) await handler();

  return { state: ctx.state, result };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

/** Maximum request body size (5 MB) to prevent memory exhaustion attacks. */
const MAX_BODY_SIZE = 5 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy(new Error("Request body too large"));
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ── HTTP server (node:http) ──────────────────────────────────────────────
// Uses node:http directly instead of Hono because @hono/node-server's
// adapter redefines globalThis.Request which conflicts with secure-exec's
// frozen built-in globals.

/**
 * Handles HTTP request errors with sanitized messages. Returns a generic
 * "Internal error" for 5xx to avoid leaking stack traces, file paths, or
 * schema structures. 4xx errors use controlled messages that are safe to expose.
 */
function handleRequestError(err: unknown, req: IncomingMessage, res: ServerResponse): void {
  const status = (err as { status?: number }).status ?? 500;
  const detail = err instanceof Error ? err.message : "Internal error";
  console.error(`[harness] ${req.method} ${req.url} error (${status}):`, detail);
  const message = status >= 500 ? "Internal error" : detail;
  json(res, { error: message }, status);
}

export function startHarness(agent: AgentDef): void {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/config") {
        json(res, extractConfig(agent));
        return;
      }
      if (req.method === "POST" && req.url === "/tool") {
        const body = JSON.parse(await readBody(req)) as ToolCallRequest;
        json(res, await executeTool(agent, body));
        return;
      }
      if (req.method === "POST" && req.url === "/hook") {
        const body = JSON.parse(await readBody(req)) as HookRequest;
        json(res, await invokeHook(agent, body));
        return;
      }
      json(res, { error: "Not found" }, 404);
    } catch (err: unknown) {
      handleRequestError(err, req, res);
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    process.stdout.write(`${JSON.stringify({ port: addr.port })}\n`);
  });
}
