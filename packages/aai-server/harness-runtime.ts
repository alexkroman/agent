// Copyright 2025 the AAI authors. MIT license.
/** Sandbox harness runtime — runs inside the secure-exec V8 isolate. */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AgentHooks, callResolveTurnConfig, createAgentHooks } from "@alexkroman1/aai/hooks";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef, ToolContext } from "@alexkroman1/aai/types";

// Types duplicated from rpc-schemas.ts — the harness runs in a secure-exec
// isolate where the bundler cannot resolve ./rpc-schemas.ts (it imports zod).
// Keep these in sync with the Zod schemas in rpc-schemas.ts.
type IsolateConfig = {
  name: string;
  systemPrompt: string;
  greeting?: string;
  sttPrompt?: string;
  maxSteps?: number;
  toolChoice?: "auto" | "required";
  builtinTools?: string[];
  toolSchemas: { name: string; description: string; parameters: Record<string, unknown> }[];
  hasState: boolean;
  hooks: {
    onConnect: boolean;
    onDisconnect: boolean;
    onError: boolean;
    onUserTranscript: boolean;
    maxStepsIsFn: boolean;
  };
};
type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: { role: "user" | "assistant" | "tool"; content: string }[];
};
type ToolCallResponse = { result: string; state: Record<string, unknown> };
type HookRequest = { hook: string; sessionId: string; text?: string; error?: { message: string } };
type HookResponse = { state: Record<string, unknown>; result?: unknown };

/** Lazily initialized per-session state manager. */
function createSessionStateMap(initState?: () => Record<string, unknown>): {
  get(sessionId: string): Record<string, unknown>;
  set(sessionId: string, state: Record<string, unknown>): void;
  delete(sessionId: string): boolean;
} {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get(sessionId: string): Record<string, unknown> {
      if (!map.has(sessionId) && initState) {
        map.set(sessionId, initState());
      }
      return map.get(sessionId) ?? {};
    },
    set(sessionId: string, state: Record<string, unknown>): void {
      map.set(sessionId, state);
    },
    delete(sessionId: string): boolean {
      return map.delete(sessionId);
    },
  };
}

/** Lightweight error with HTTP status for RPC responses. */
class RpcError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const HARNESS_AUTH_TOKEN = process.env.HARNESS_AUTH_TOKEN ?? "";

const AAI_ENV_PREFIX = "AAI_ENV_";
const agentEnv: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
      .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
  ),
);

// ── KV bridge via sidecar server ────────────────────────────────────────

const SIDECAR_URL = process.env.SIDECAR_URL ?? "";

async function kvRpc<T>(body: unknown): Promise<T> {
  const res = await fetch(`${SIDECAR_URL}/kv`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-harness-token": HARNESS_AUTH_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`kv failed: ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (null as T);
}

const kv: Kv = {
  get<T = unknown>(key: string) {
    return kvRpc<T | null>({ op: "get", key });
  },
  set(key: string, value: unknown, options?: { expireIn?: number }) {
    return kvRpc<void>({ op: "set", key, value, ...options });
  },
  delete(key: string) {
    return kvRpc<void>({ op: "del", key });
  },
  list<T = unknown>(prefix: string, options?: { limit?: number; reverse?: boolean }) {
    return kvRpc<{ key: string; value: T }[]>({ op: "list", prefix, ...options });
  },
  keys(pattern?: string) {
    return kvRpc<string[]>({ op: "keys", pattern });
  },
};

// ── Agent introspection ─────────────────────────────────────────────────

let sessionState: ReturnType<typeof createSessionStateMap>;
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
    systemPrompt: agent.systemPrompt,
    greeting: agent.greeting,
    toolSchemas: extractToolSchemas(agent),
    hasState: typeof agent.state === "function",
    hooks: {
      onConnect: typeof agent.onConnect === "function",
      onDisconnect: typeof agent.onDisconnect === "function",
      onError: typeof agent.onError === "function",
      onUserTranscript: typeof agent.onUserTranscript === "function",
      maxStepsIsFn: typeof agent.maxSteps === "function",
    },
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
  return config;
}

// ── Tool execution ──────────────────────────────────────────────────────

/** Must match HARNESS_TOOL_TIMEOUT_MS in constants.ts (30s). */
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

// ── Hook invocation ─────────────────────────────────────────────────────

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
    case "onUserTranscript":
      await hooks.callHook("userTranscript", req.sessionId, req.text ?? "");
      break;
    case "resolveTurnConfig":
      result = await callResolveTurnConfig(hooks, req.sessionId);
      break;
    default:
      break;
  }
  return { state: sessionState.get(req.sessionId), result };
}

// ── HTTP RPC server ─────────────────────────────────────────────────────

/** Must match HARNESS_MAX_BODY_SIZE in constants.ts (5 MB). */
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
  if (!HARNESS_AUTH_TOKEN) return true;
  const token = req.headers["x-harness-token"];
  if (typeof token !== "string" || token.length !== HARNESS_AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(HARNESS_AUTH_TOKEN));
}

type RpcRequest =
  | { type: "config" }
  | ({ type: "tool" } & ToolCallRequest)
  | ({ type: "hook" } & HookRequest);

async function dispatch(agent: AgentDef, msg: RpcRequest): Promise<unknown> {
  switch (msg.type) {
    case "config":
      return extractConfig(agent);
    case "tool":
      return executeTool(agent, msg);
    case "hook":
      return invokeHook(msg);
    default:
      throw new RpcError("Unknown RPC type", 400);
  }
}

export function startHarness(agent: AgentDef): void {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }
  sessionState = createSessionStateMap(agent.state);
  hooks = createAgentHooks({
    agent,
    makeCtx: (sid) => ({ env: agentEnv, state: sessionState.get(sid), sessionId: sid, kv }),
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
        msg = JSON.parse(await readBody(req)) as RpcRequest;
      } catch {
        json(res, { error: "Invalid JSON" }, 400);
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
    if (!addr || typeof addr === "string") throw new Error("Bad server address");
    process.stdout.write(`${JSON.stringify({ port: addr.port })}\n`);
  });
}
