// Copyright 2025 the AAI authors. MIT license.
/** Sandbox harness runtime -- runs inside the secure-exec V8 isolate. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AgentHooks, callResolveTurnConfig, createAgentHooks } from "@alexkroman1/aai/hooks";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef, ToolContext } from "@alexkroman1/aai/types";
import { createSessionStateMap } from "@alexkroman1/aai/utils";
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  RpcRequest,
  RpcResponse,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness-protocol.ts";

/** Lightweight error with HTTP status for RPC responses (no external deps). */
class RpcError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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
  // Host-validated: the sidecar runs in the same server process and returns
  // trusted responses. Schema validation happens host-side (see sandbox-sidecar.ts).
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

// Lazily-initialized per-session state (shared pattern with self-hosted mode).
let sessionState: ReturnType<typeof createSessionStateMap>;
// Hookable-based lifecycle hooks (same system as self-hosted mode).
let hooks: AgentHooks;

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
      maxStepsIsFn: typeof agent.maxSteps === "function",
    },
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
  return config;
}

/** Tool timeout — must match HARNESS_TOOL_TIMEOUT_MS in constants.ts (30s).
 *  Defined inline because the harness cannot import workspace packages at runtime. */
const TOOL_TIMEOUT_MS = 30_000;

async function executeTool(agent: AgentDef, req: ToolCallRequest): Promise<ToolCallResponse> {
  const tool = agent.tools[req.name];
  if (!tool) throw new RpcError(`Unknown tool: ${req.name}`, 404);

  const ctx: ToolContext = {
    env: agentEnv,
    state: sessionState.get(req.sessionId),
    sessionId: req.sessionId,
    kv,
    messages: req.messages,
    fetch: sidecarFetch,
  };

  const parsed =
    tool.parameters && typeof tool.parameters.parse === "function"
      ? tool.parameters.parse(req.args)
      : req.args;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      tool.execute(parsed, ctx),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(new RpcError(`Tool "${req.name}" timed out after ${TOOL_TIMEOUT_MS}ms`, 504)),
          TOOL_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
      state: ctx.state,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function invokeHook(req: HookRequest): Promise<HookResponse> {
  let result: unknown;

  switch (req.hook) {
    case "onConnect":
      await hooks.callHook("connect", req.sessionId);
      break;
    case "onDisconnect":
      await hooks.callHook("disconnect", req.sessionId);
      sessionState.delete(req.sessionId);
      break;
    case "onTurn":
      await hooks.callHook("turn", req.sessionId, req.text ?? "");
      break;
    case "onError":
      await hooks.callHook("error", req.sessionId, {
        message: req.error?.message ?? "Unknown error",
      });
      break;
    case "resolveTurnConfig":
      result = await callResolveTurnConfig(hooks, req.sessionId);
      break;
    default:
      break;
  }

  return { state: sessionState.get(req.sessionId), result };
}

/** Must match HARNESS_MAX_BODY_SIZE in constants.ts (5 MB).
 *  Defined inline because the harness cannot import workspace packages at runtime. */
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
        throw new RpcError("Invalid tool call request: missing name or sessionId", 400);
      }
      return executeTool(agent, msg);
    }
    case "hook": {
      if (!msg.hook || typeof msg.hook !== "string" || !msg.sessionId) {
        throw new RpcError("Invalid hook request: missing hook or sessionId", 400);
      }
      return invokeHook(msg);
    }
    default: {
      const _: never = msg;
      throw new RpcError(`Unknown RPC type: ${(_ as { type: string }).type}`, 400);
    }
  }
}

export function startHarness(agent: AgentDef): void {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }
  sessionState = createSessionStateMap(agent.state);
  hooks = createAgentHooks({
    agent,
    makeCtx: (sid) => ({
      env: agentEnv,
      state: sessionState.get(sid),
      sessionId: sid,
      kv,
      fetch: sidecarFetch,
    }),
  });

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
        // Host-validated: sandbox.ts validates RPC responses with Zod schemas
        // (see callIsolate). The isolate trusts the host since both run in
        // the same server process.
        msg = JSON.parse(await readBody(req)) as RpcRequest;
      } catch {
        json(res, { error: "Invalid JSON in request body" }, 400);
        return;
      }
      const result = await dispatch(agent, msg);
      json(res, result);
    } catch (err: unknown) {
      const status = err instanceof RpcError ? err.status : 500;
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
