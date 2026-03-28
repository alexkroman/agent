// Copyright 2025 the AAI authors. MIT license.
/** Sandbox harness runtime -- runs inside the secure-exec V8 isolate. */
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
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  RpcRequest,
  RpcResponse,
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

// Capture the original fetch before we override globalThis.fetch below.
// sidecarRpc must use the raw fetch to reach the sidecar on loopback.
const _originalFetch = globalThis.fetch;

async function sidecarRpc<T>(path: string, body: unknown): Promise<T> {
  const res = await _originalFetch(`${SIDECAR_URL}${path}`, {
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

type ProxyData = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

/** Proxied fetch routed through the sidecar with SSRF protection on the host. */
async function sidecarFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = req.body ? await req.text() : null;
  const proxyRes = await sidecarRpc<ProxyData>("/fetch", {
    url: req.url,
    method: req.method,
    headers,
    body,
  });
  return new Response(Buffer.from(proxyRes.body, "base64"), {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers: new Headers(proxyRes.headers),
  });
}

// Override globalThis.fetch so bare fetch() in tool code proxies through sidecar.
try {
  Object.defineProperty(globalThis, "fetch", {
    value: sidecarFetch,
    writable: true,
    configurable: true,
  });
} catch {
  /* secure-exec may prevent override; ctx.fetch still works */
}

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
      maxStepsIsFn: typeof agent.maxSteps === "function",
      hasMiddleware: Array.isArray(agent.middleware) && agent.middleware.length > 0,
    },
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
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
    sessionId: req.sessionId,
    kv,
    messages: req.messages,
    sendUpdate() {
      /* no-op in sandbox -- no WebSocket access */
    },
    fetch: sidecarFetch,
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
    sessionId: req.sessionId,
    kv,
    fetch: sidecarFetch,
  };
}

async function runResolveTurnConfig(
  agent: AgentDef,
  ctx: HookContext,
): Promise<{ maxSteps?: number } | null> {
  if (typeof agent.maxSteps === "function") {
    const maxSteps = (await agent.maxSteps(ctx)) ?? undefined;
    if (maxSteps !== undefined) return { maxSteps };
  }
  return null;
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

  try {
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
      case "resolveTurnConfig":
        result = await runResolveTurnConfig(agent, ctx);
        break;
      default:
        result = await invokeMiddlewareHook(agent, req, ctx);
        break;
    }
  } catch (err) {
    sessionStates.delete(req.sessionId);
    throw err;
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

async function dispatch(agent: AgentDef, msg: RpcRequest): Promise<RpcResponse> {
  switch (msg.type) {
    case "config":
      return extractConfig(agent);
    case "tool": {
      if (!msg.name || typeof msg.name !== "string" || !msg.sessionId) {
        throw Object.assign(new Error("Invalid tool call request: missing name or sessionId"), {
          status: 400,
        });
      }
      return executeTool(agent, msg);
    }
    case "hook": {
      if (!msg.hook || typeof msg.hook !== "string" || !msg.sessionId) {
        throw Object.assign(new Error("Invalid hook request: missing hook or sessionId"), {
          status: 400,
        });
      }
      return invokeHook(agent, msg);
    }
    default: {
      const _: never = msg;
      throw Object.assign(new Error(`Unknown RPC type: ${(_ as { type: string }).type}`), {
        status: 400,
      });
    }
  }
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
      if (req.method !== "POST" || req.url !== "/rpc") {
        json(res, { error: "Not found" }, 404);
        return;
      }
      let msg: RpcRequest;
      try {
        msg = JSON.parse(await readBody(req)) as RpcRequest;
      } catch {
        json(res, { error: "Invalid JSON in request body" }, 400);
        return;
      }
      const result = await dispatch(agent, msg);
      json(res, result);
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
