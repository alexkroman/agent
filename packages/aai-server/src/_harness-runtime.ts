// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness runtime — runs inside the secure-exec V8 isolate.
 *
 * Boots the same `createRuntime()` + WebSocket server as self-hosted mode.
 * The host just proxies client WebSocket connections to this server.
 */
import { createServer } from "node:http";
import { createRuntime, type SessionWebSocket } from "@alexkroman1/aai/internal";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef } from "@alexkroman1/aai/types";
import nodeAdapter from "crossws/adapters/node";

// Strip AAI_ENV_ prefix so tools/hooks see original key names.
const AAI_ENV_PREFIX = "AAI_ENV_";
const agentEnv: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
      .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
  ),
);

// ── KV bridge via network adapter ───────────────────────────────────────

const KV_ORIGIN = "http://kv.internal";

async function kvRpc<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${KV_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`kv${path} failed: ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (null as T);
}

const kv: Kv = {
  get<T = unknown>(key: string) {
    return kvRpc<T | null>("/get", { key });
  },
  set(key: string, value: unknown, options?: { expireIn?: number }) {
    return kvRpc<void>("/set", { key, value, options });
  },
  delete(key: string) {
    return kvRpc<void>("/del", { key });
  },
  list<T = unknown>(prefix: string, options?: { limit?: number; reverse?: boolean }) {
    return kvRpc<{ key: string; value: T }[]>("/list", { prefix, ...options });
  },
  keys(pattern?: string) {
    return kvRpc<string[]>("/keys", { pattern });
  },
};

// ── Harness entry point ─────────────────────────────────────────────────

export function startHarness(agent: AgentDef): void {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  const runtime = createRuntime({
    agent,
    env: agentEnv,
    kv,
  });

  // WebSocket server using crossws + node:http (same as self-hosted mode)
  const wsAdapter = nodeAdapter({
    hooks: {
      open(peer) {
        const reqUrl = peer.request?.url ?? "/";
        const qIdx = reqUrl.indexOf("?");
        const search = qIdx >= 0 ? reqUrl.slice(qIdx + 1) : "";
        const getParam = (key: string): string | undefined => {
          const re = new RegExp(`(?:^|&)${key}=([^&]*)`);
          const m = search.match(re);
          return m?.[1] ? decodeURIComponent(m[1]) : undefined;
        };
        const hasParam = (key: string): boolean => search.includes(key);
        const resumeFrom = getParam("sessionId");
        const skipGreeting = hasParam("resume") || resumeFrom !== undefined;
        const rawWs = peer.websocket as unknown as SessionWebSocket;
        runtime.startSession(rawWs, {
          skipGreeting,
          ...(resumeFrom ? { resumeFrom } : {}),
        });
      },
    },
  });

  const server = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("upgrade", (req, socket, head) => {
    wsAdapter.handleUpgrade(req as never, socket as never, head as never);
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error(`Expected server address with numeric port, got: ${JSON.stringify(addr)}`);
    }
    process.stdout.write(`${JSON.stringify({ port: addr.port, name: agent.name })}\n`);
  });
}
