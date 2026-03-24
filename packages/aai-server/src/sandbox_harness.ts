// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness template — code that runs inside the secure-exec isolate.
 *
 * The harness imports the agent bundle, starts a tiny HTTP server on loopback,
 * and exposes endpoints for the host to:
 * - GET /config   — extract agent metadata and tool schemas
 * - POST /tool    — execute a tool by name
 * - POST /hook    — invoke a lifecycle hook
 *
 * KV and vector access is proxied back to a per-sandbox capability server
 * on the host (no auth needed, loopback only).
 *
 * @module
 */

/**
 * Generate the harness script that will run inside the secure-exec isolate.
 *
 * @param capUrl - Loopback URL for the per-sandbox capability server (KV/vector).
 */
export function generateHarnessScript(capUrl: string): string {
  return `
"use strict";
import http from "node:http";
import agent from "./agent_bundle.js";

const CAP_URL = ${JSON.stringify(capUrl)};

// ── KV proxy ─────────────────────────────────────────────────────────────

async function capRpc(path, body) {
  const res = await fetch(CAP_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(path + " failed: " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const kv = {
  get(key) { return capRpc("/kv/get", { key }); },
  set(key, value, options) { return capRpc("/kv/set", { key, value, options }); },
  delete(key) { return capRpc("/kv/del", { key }); },
  list(prefix, options) { return capRpc("/kv/list", { prefix, ...options }); },
  keys(pattern) { return capRpc("/kv/keys", { pattern }); },
};

const vector = {
  upsert(id, data, metadata) { return capRpc("/vec/upsert", { id, data, metadata }); },
  query(text, options) { return capRpc("/vec/query", { text, ...options }); },
  remove(ids) { return capRpc("/vec/remove", { ids: Array.isArray(ids) ? ids : [ids] }); },
};

// ── Per-session state ────────────────────────────────────────────────────

const sessionStates = new Map();

function getState(sessionId) {
  if (!sessionStates.has(sessionId) && agent.state) {
    sessionStates.set(sessionId, agent.state());
  }
  return sessionStates.get(sessionId) || {};
}

// ── Tool schemas ─────────────────────────────────────────────────────────

function extractToolSchemas() {
  const schemas = [];
  for (const [name, def] of Object.entries(agent.tools || {})) {
    schemas.push({
      name,
      description: def.description,
      parameters: def.parameters
        ? (typeof def.parameters.toJSON === "function"
            ? def.parameters.toJSON()
            : def.parameters)
        : { type: "object", properties: {} },
    });
  }
  return schemas;
}

// ── Request body reader ──────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: agent.name,
        instructions: agent.instructions,
        greeting: agent.greeting,
        sttPrompt: agent.sttPrompt,
        maxSteps: typeof agent.maxSteps === "function" ? undefined : agent.maxSteps,
        toolChoice: agent.toolChoice,
        builtinTools: agent.builtinTools,
        activeTools: agent.activeTools,
        toolSchemas: extractToolSchemas(),
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
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/tool") {
      const body = JSON.parse(await readBody(req));
      const { name, args, sessionId, messages, env } = body;
      const tool = (agent.tools || {})[name];
      if (!tool) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Unknown tool: " + name }));
        return;
      }
      const ctx = {
        env: Object.freeze(env || {}),
        abortSignal: AbortSignal.timeout(30000),
        state: getState(sessionId || ""),
        kv,
        vector,
        messages: messages || [],
      };
      const result = await tool.execute(
        tool.parameters && typeof tool.parameters.parse === "function"
          ? tool.parameters.parse(args)
          : args,
        ctx,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        result: typeof result === "string" ? result : JSON.stringify(result),
        state: ctx.state,
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/hook") {
      const body = JSON.parse(await readBody(req));
      const { hook, sessionId, env, text, error, step, stepNumber } = body;
      const ctx = {
        env: Object.freeze(env || {}),
        state: getState(sessionId || ""),
        kv,
        vector,
      };

      let result = undefined;
      switch (hook) {
        case "onConnect":
          await agent.onConnect?.(ctx);
          break;
        case "onDisconnect":
          await agent.onDisconnect?.(ctx);
          sessionStates.delete(sessionId || "");
          break;
        case "onTurn":
          await agent.onTurn?.(text, ctx);
          break;
        case "onError":
          await agent.onError?.(new Error(error?.message || "Unknown error"), ctx);
          break;
        case "onStep":
          await agent.onStep?.(step, ctx);
          break;
        case "onBeforeStep":
          result = await agent.onBeforeStep?.(stepNumber || 0, ctx);
          break;
        case "resolveTurnConfig": {
          const config = {};
          if (typeof agent.maxSteps === "function") {
            config.maxSteps = await agent.maxSteps(ctx);
          }
          if (agent.onBeforeStep) {
            const r = await agent.onBeforeStep(0, ctx);
            if (r?.activeTools) config.activeTools = r.activeTools;
          }
          result = (config.maxSteps !== undefined || config.activeTools !== undefined)
            ? config : null;
          break;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: ctx.state, result }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(JSON.stringify({ port: addr.port }) + "\\n");
});
`;
}
