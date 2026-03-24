// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness runtime — runs inside the secure-exec isolate.
 *
 * This file is type-checked at compile time against the shared protocol
 * types and AgentDef. At runtime, the compiled JS is loaded into the
 * isolate's virtual filesystem and executed.
 *
 * Environment variables (set by host):
 * - CAP_URL: loopback URL for the per-sandbox capability server
 *
 * The agent bundle is expected at "./agent_bundle.js" (default export).
 *
 * @module
 */

import http from "node:http";
import type { ToolSchema } from "@alexkroman1/aai/internal-types";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef, HookContext, Message, ToolContext } from "@alexkroman1/aai/types";
import type { VectorStore } from "@alexkroman1/aai/vector";
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness_protocol.ts";

const CAP_URL = process.env.CAP_URL ?? "";

// ── Capability server proxy (KV / vector) ────────────────────────────────

async function capRpc<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CAP_URL}${path}`, {
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
    return capRpc<T | null>("/kv/get", { key });
  },
  set(key: string, value: unknown, options?: { expireIn?: number }) {
    return capRpc<void>("/kv/set", { key, value, options });
  },
  delete(key: string) {
    return capRpc<void>("/kv/del", { key });
  },
  list<T = unknown>(prefix: string, options?: { limit?: number; reverse?: boolean }) {
    return capRpc<{ key: string; value: T }[]>("/kv/list", { prefix, ...options });
  },
};

const vector: VectorStore = {
  upsert(id: string, data: string, metadata?: Record<string, unknown>) {
    return capRpc<void>("/vec/upsert", { id, data, metadata });
  },
  query(text: string, options?: { topK?: number; filter?: string }) {
    return capRpc("/vec/query", { text, ...options });
  },
  remove(ids: string | string[]) {
    return capRpc<void>("/vec/remove", { ids: Array.isArray(ids) ? ids : [ids] });
  },
};

// ── Per-session state ────────────────────────────────────────────────────

const sessionStates = new Map<string, Record<string, unknown>>();

function getState(agent: AgentDef, sessionId: string): Record<string, unknown> {
  if (!sessionStates.has(sessionId) && agent.state) {
    sessionStates.set(sessionId, agent.state() as Record<string, unknown>);
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
    abortSignal: AbortSignal.timeout(30_000),
    state: getState(agent, req.sessionId),
    kv,
    vector,
    messages: req.messages as Message[],
  };

  const parsed =
    tool.parameters && typeof tool.parameters.parse === "function"
      ? tool.parameters.parse(req.args)
      : req.args;

  const result = await tool.execute(parsed, ctx);
  return {
    result: typeof result === "string" ? result : JSON.stringify(result),
    state: ctx.state as Record<string, unknown>,
  };
}

// ── Hook invocation ──────────────────────────────────────────────────────

async function invokeHook(agent: AgentDef, req: HookRequest): Promise<HookResponse> {
  const ctx: HookContext = {
    env: Object.freeze(req.env),
    state: getState(agent, req.sessionId),
    kv,
    vector,
  };

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
      agent.onError?.(new Error(req.error?.message ?? "Unknown error"), ctx);
      break;
    case "onStep":
      if (req.step) await agent.onStep?.(req.step, ctx);
      break;
    case "onBeforeStep":
      result = await agent.onBeforeStep?.(req.stepNumber ?? 0, ctx);
      break;
    case "resolveTurnConfig": {
      const config: { maxSteps?: number; activeTools?: string[] } = {};
      if (typeof agent.maxSteps === "function") {
        config.maxSteps = (await agent.maxSteps(ctx)) ?? undefined;
      }
      if (agent.onBeforeStep) {
        const r = await agent.onBeforeStep(0, ctx);
        if (r?.activeTools) config.activeTools = r.activeTools;
      }
      result = config.maxSteps !== undefined || config.activeTools !== undefined ? config : null;
      break;
    }
  }

  return { state: ctx.state as Record<string, unknown>, result };
}

// ── HTTP server ──────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function startHarness(): Promise<void> {
  // @ts-expect-error agent_bundle.js is written to the isolate's virtual filesystem at runtime
  const mod = await import("./agent_bundle.js");
  const agent = mod.default as AgentDef;

  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/config") {
        const config = extractConfig(agent);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config));
        return;
      }

      if (req.method === "POST" && req.url === "/tool") {
        const body = JSON.parse(await readBody(req)) as ToolCallRequest;
        const result = await executeTool(agent, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && req.url === "/hook") {
        const body = JSON.parse(await readBody(req)) as HookRequest;
        const result = await invokeHook(agent, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    process.stdout.write(`${JSON.stringify({ port: addr.port })}\n`);
  });
}

startHarness();
