// Copyright 2025 the AAI authors. MIT license.
/** Sandbox harness runtime — runs inside the secure-exec V8 isolate. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Kv } from "@alexkroman1/aai/kv";
import {
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
  runInputFilters,
  runOutputFilters,
  runToolCallInterceptors,
} from "@alexkroman1/aai/middleware-core";
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
const HARNESS_AUTH_TOKEN = process.env.HARNESS_AUTH_TOKEN ?? "";

// Strip AAI_ENV_ prefix so tools/hooks see original key names.
const AAI_ENV_PREFIX = "AAI_ENV_";
const agentEnv: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
      .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
  ),
);

async function sidecarRpc<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SIDECAR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  delete(key: string) {
    return sidecarRpc<void>("/kv/del", { key });
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
  delete(ids: string | string[]) {
    return sidecarRpc<void>("/vec/delete", { ids: Array.isArray(ids) ? ids : [ids] });
  },
};

const sessionStates = new Map<string, Record<string, unknown>>();

function getState(agent: AgentDef, sessionId: string): Record<string, unknown> {
  if (!sessionStates.has(sessionId) && agent.state) {
    sessionStates.set(sessionId, agent.state());
  }
  return sessionStates.get(sessionId) ?? {};
}

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

// Must equal TOOL_TIMEOUT_MS (30s) - TOOL_TIMEOUT_MARGIN_MS (5s) in sandbox.ts
// so the isolate returns a clean error before the host-side timeout aborts.
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

async function invokeMiddlewareHook(
  agent: AgentDef,
  req: HookRequest,
  ctx: HookContext,
): Promise<unknown> {
  const middleware: readonly Middleware[] = agent.middleware ?? [];
  switch (req.hook) {
    case "filterInput":
      return runInputFilters(middleware, req.text ?? "", ctx);
    case "beforeTurn": {
      const r = await runBeforeTurnMiddleware(middleware, req.text ?? "", ctx);
      return r?.reason;
    }
    case "afterTurn":
      await runAfterTurnMiddleware(middleware, req.text ?? "", ctx);
      return;
    case "interceptToolCall":
      return runToolCallInterceptors(
        middleware,
        req.step?.toolCalls[0]?.toolName ?? "",
        (req.step?.toolCalls[0]?.args as Record<string, unknown>) ?? {},
        ctx,
      );
    case "afterToolCall":
      await runAfterToolCallMiddleware(
        middleware,
        req.step?.toolCalls[0]?.toolName ?? "",
        (req.step?.toolCalls[0]?.args as Record<string, unknown>) ?? {},
        req.text ?? "",
        ctx,
      );
      return;
    case "filterOutput":
      return runOutputFilters(middleware, req.text ?? "", ctx);
    default:
      return;
  }
}

async function invokeHook(agent: AgentDef, req: HookRequest): Promise<HookResponse> {
  const ctx = makeHookCtx(agent, req);
  let result: unknown;

  switch (req.hook) {
    case "onConnect":
      await agent.onConnect?.(ctx);
      break;
    case "onDisconnect":
      await agent.onDisconnect?.(ctx);
      sessionStates.delete(req.sessionId);
      break;
    case "onTurn":
      await agent.onTurn?.(req.text ?? "", ctx);
      break;
    case "onError":
      await agent.onError?.(new Error(req.error?.message ?? "Unknown error"), ctx);
      break;
    case "onStep":
      if (req.step) await agent.onStep?.(req.step, ctx);
      break;
    case "onBeforeStep":
      result = await agent.onBeforeStep?.(req.stepNumber ?? 0, ctx);
      break;
    case "resolveTurnConfig":
      result = await runResolveTurnConfig(agent, ctx, req.stepNumber ?? 0);
      break;
    default:
      result = await invokeMiddlewareHook(agent, req, ctx);
      break;
  }

  return { state: ctx.state, result };
}

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

function isAuthorized(req: IncomingMessage): boolean {
  return !HARNESS_AUTH_TOKEN || req.headers["x-harness-token"] === HARNESS_AUTH_TOKEN;
}

type RouteResult = { data: unknown; status?: number };

async function parseJsonBody<T>(req: IncomingMessage): Promise<T | RouteResult> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    return { data: { error: "Invalid JSON in request body" }, status: 400 };
  }
}

function isRouteResult(v: unknown): v is RouteResult {
  return typeof v === "object" && v !== null && "data" in v;
}

async function handleToolRoute(agent: AgentDef, req: IncomingMessage): Promise<RouteResult> {
  const body = await parseJsonBody<ToolCallRequest>(req);
  if (isRouteResult(body)) return body;
  if (!body || typeof body.name !== "string" || typeof body.sessionId !== "string") {
    return {
      data: { error: "Invalid tool call request: missing name or sessionId" },
      status: 400,
    };
  }
  return { data: await executeTool(agent, body) };
}

async function handleHookRoute(agent: AgentDef, req: IncomingMessage): Promise<RouteResult> {
  const body = await parseJsonBody<HookRequest>(req);
  if (isRouteResult(body)) return body;
  if (!body || typeof body.hook !== "string" || typeof body.sessionId !== "string") {
    return { data: { error: "Invalid hook request: missing hook or sessionId" }, status: 400 };
  }
  return { data: await invokeHook(agent, body) };
}

async function handleRoute(agent: AgentDef, req: IncomingMessage): Promise<RouteResult> {
  if (req.method === "GET" && req.url === "/config") {
    return { data: extractConfig(agent) };
  }
  if (req.method === "POST" && req.url === "/tool") {
    return handleToolRoute(agent, req);
  }
  if (req.method === "POST" && req.url === "/hook") {
    return handleHookRoute(agent, req);
  }
  return { data: { error: "Not found" }, status: 404 };
}

export function startHarness(agent: AgentDef): void {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  const server = createServer(async (req, res) => {
    try {
      if (!isAuthorized(req)) {
        json(res, { error: "Unauthorized" }, 401);
        return;
      }
      const { data, status } = await handleRoute(agent, req);
      json(res, data, status);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : "Internal error";
      json(res, { error: message }, status);
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error(`Expected server address with numeric port, got: ${JSON.stringify(addr)}`);
    }
    process.stdout.write(`${JSON.stringify({ port: addr.port })}\n`);
  });
}
