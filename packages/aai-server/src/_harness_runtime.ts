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
 *
 * The agent bundle is expected at "./agent_bundle.js" (default export).
 *
 * @module
 */

// V8 isolates run scripts (not modules) — use require(), not import.
// Type imports are erased at compile time so they don't affect runtime.
import type * as Http from "node:http";
import type { ToolSchema } from "@alexkroman1/aai/internal-types";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef, HookContext, ToolContext } from "@alexkroman1/aai/types";
import type { VectorStore } from "@alexkroman1/aai/vector";
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness_protocol.ts";

// CJS require — V8 isolates run scripts, not modules
const http: typeof Http = require("node:http");

const SIDECAR_URL = process.env.SIDECAR_URL ?? "";

// ── Sidecar server proxy (KV / vector) ───────────────────────────────────

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

function extractToolSchemas(agent: AgentDef): ToolSchema[] {
  return Object.entries(agent.tools).map(([name, def]) => ({
    name,
    description: def.description,
    parameters:
      def.parameters && "toJSON" in def.parameters && typeof def.parameters.toJSON === "function"
        ? (def.parameters.toJSON() as ToolSchema["parameters"])
        : ({ type: "object", properties: {} } as ToolSchema["parameters"]),
  }));
}

// ── Config extraction ────────────────────────────────────────────────────

function extractConfig(agent: AgentDef): IsolateConfig {
  return {
    name: agent.name,
    instructions: agent.instructions,
    greeting: agent.greeting,
    ...(agent.sttPrompt !== undefined ? { sttPrompt: agent.sttPrompt } : {}),
    ...(typeof agent.maxSteps !== "function" ? { maxSteps: agent.maxSteps } : {}),
    ...(agent.toolChoice !== undefined ? { toolChoice: agent.toolChoice } : {}),
    ...(agent.builtinTools ? { builtinTools: agent.builtinTools } : {}),
    ...(agent.activeTools ? { activeTools: agent.activeTools } : {}),
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
    },
  };
}

// ── Tool execution ───────────────────────────────────────────────────────

async function executeTool(agent: AgentDef, req: ToolCallRequest): Promise<ToolCallResponse> {
  const tool = agent.tools[req.name];
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${req.name}`), { status: 404 });

  const ctx: ToolContext = {
    env: Object.freeze(req.env),
    state: getState(agent, req.sessionId),
    kv,
    vector,
    messages: req.messages,
  };

  const parsed =
    tool.parameters && typeof tool.parameters.parse === "function"
      ? tool.parameters.parse(req.args)
      : req.args;

  const result = await tool.execute(parsed, ctx);
  return {
    result: typeof result === "string" ? result : JSON.stringify(result),
    state: ctx.state,
  };
}

// ── Hook invocation ──────────────────────────────────────────────────────

function makeHookCtx(agent: AgentDef, req: HookRequest): HookContext {
  return {
    env: Object.freeze(req.env),
    state: getState(agent, req.sessionId),
    kv,
    vector,
  };
}

async function runResolveTurnConfig(
  agent: AgentDef,
  ctx: HookContext,
): Promise<{ maxSteps?: number; activeTools?: string[] } | null> {
  const config: { maxSteps?: number; activeTools?: string[] } = {};
  if (typeof agent.maxSteps === "function") {
    config.maxSteps = (await agent.maxSteps(ctx)) ?? undefined;
  }
  if (agent.onBeforeStep) {
    const r = await agent.onBeforeStep(0, ctx);
    if (r?.activeTools) config.activeTools = r.activeTools;
  }
  return config.maxSteps !== undefined || config.activeTools !== undefined ? config : null;
}

async function invokeHook(agent: AgentDef, req: HookRequest): Promise<HookResponse> {
  const ctx = makeHookCtx(agent, req);
  let result: unknown;

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
      result = await runResolveTurnConfig(agent, ctx);
    },
  };

  const handler = handlers[req.hook];
  if (handler) await handler();

  return { state: ctx.state, result };
}

// ── HTTP server ──────────────────────────────────────────────────────────

function readBody(req: Http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function assertShape<T>(value: unknown, requiredKeys: string[], label: string): T {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label}: expected object, got ${typeof value}`);
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      throw new Error(`${label}: missing required key "${key}"`);
    }
  }
  return value as T;
}

type Route = (req: Http.IncomingMessage) => Promise<unknown>;

function buildRoutes(agent: AgentDef): Record<string, Route> {
  return {
    "GET /config": async () => extractConfig(agent),
    "POST /tool": async (req) => {
      const body = assertShape<ToolCallRequest>(
        JSON.parse(await readBody(req)),
        ["name", "args", "sessionId", "messages", "env"],
        "ToolCallRequest",
      );
      return executeTool(agent, body);
    },
    "POST /hook": async (req) => {
      const body = assertShape<HookRequest>(
        JSON.parse(await readBody(req)),
        ["hook", "sessionId", "env"],
        "HookRequest",
      );
      return invokeHook(agent, body);
    },
  };
}

function getErrorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = (err as Record<string, unknown>).status;
    if (typeof s === "number") return s;
  }
  return 500;
}

function startHarness(): void {
  const mod = require("./agent_bundle.js") as { default?: unknown };
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  const routes = buildRoutes(agent);

  const server = http.createServer(async (req, res) => {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (!handler) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      const result = await handler(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(getErrorStatus(err), { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    process.stdout.write(`${JSON.stringify({ port: addr.port })}\n`);
  });
}

startHarness();
