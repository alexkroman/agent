// Copyright 2025 the AAI authors. MIT license.
/**
 * Worker-side agent wiring over Cap'n Web RPC.
 *
 * Called inside a bundled Deno Worker to wire up the agent's tools, hooks,
 * and configuration using capnweb's object-capability RPC system.
 *
 * @module
 */

import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { z } from "zod";
import { asMessagePort } from "./_capnweb_transport.ts";
import type { AgentConfig, ToolSchema, WorkerConfig } from "./_internal_types.ts";
import { withTimeout } from "./_timeout.ts";
import { getBuiltinToolDefs } from "./builtin_tools.ts";
import type { Kv, KvEntry } from "./kv.ts";
import type { HostApi, KvRequest } from "./protocol.ts";
import type { AgentDef, HookContext, Message } from "./types.ts";
import { executeToolCall } from "./worker_entry.ts";

const FETCH_TIMEOUT_MS = 30_000;
const KV_TIMEOUT_MS = 10_000;
const EMPTY_PARAMS = z.object({});
function headersToRecord(h?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(h).entries());
}

async function serializeBody(body: BodyInit | null): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (body instanceof Blob) return await body.text();
  if (body instanceof ReadableStream) return await new Response(body).text();
  if (body instanceof FormData) {
    return new URLSearchParams(body as unknown as Record<string, string>).toString();
  }
  return String(body);
}

function createProxyKv(hostStub: HostApi): Kv {
  async function kvCall(req: KvRequest): Promise<unknown> {
    const resp = await withTimeout(hostStub.kv(req), KV_TIMEOUT_MS);
    return (resp as { result: unknown }).result;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const result = await kvCall({ op: "get", key });
      if (result === null || result === undefined) return null;
      return (typeof result === "string" ? JSON.parse(result) : result) as T;
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      const raw = JSON.stringify(value);
      await kvCall({
        op: "set",
        key,
        value: raw,
        ...(options?.expireIn ? { ttl: Math.ceil(options.expireIn / 1000) } : {}),
      });
    },
    async delete(key: string): Promise<void> {
      await kvCall({ op: "del", key });
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<KvEntry<T>[]> {
      const listReq: KvRequest = {
        op: "list",
        prefix,
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.reverse !== undefined ? { reverse: options.reverse } : {}),
      };
      const result = await kvCall(listReq);
      return result as KvEntry<T>[];
    },
  };
}

function installFetchProxy(hostStub: HostApi): void {
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: string;
    let method: string;
    let headers: Record<string, string>;
    let body: string | null;

    if (input instanceof Request) {
      url = input.url;
      method = init?.method ?? input.method;
      headers = headersToRecord(init?.headers ?? input.headers);
      body =
        init?.body != null
          ? await serializeBody(init.body)
          : input.body != null
            ? await input.text()
            : null;
    } else {
      url = String(input);
      method = init?.method ?? "GET";
      headers = headersToRecord(init?.headers);
      body = init?.body != null ? await serializeBody(init.body) : null;
    }

    const result = await withTimeout(
      hostStub.fetch({ url, method, headers, body }),
      FETCH_TIMEOUT_MS,
    );

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
}

/**
 * Cap'n Web RPC target exposed by the worker to the host.
 *
 * The host receives a stub for this class and can call its methods
 * to interact with the agent (get config, execute tools, trigger hooks).
 */
class AgentWorkerTarget extends RpcTarget {
  #agent: AgentDef;
  #toolHandlers: Map<string, AgentDef["tools"][string]>;
  #sessions = new Map<string, unknown>();
  #mergedEnv: Record<string, string> = {};
  #proxyKv: Kv | null = null;

  constructor(agent: AgentDef) {
    super();
    this.#agent = agent;
    this.#toolHandlers = new Map(Object.entries(agent.tools));
  }

  /** Install the fetch and KV proxies backed by the host stub, and register built-in tools. */
  setHostApi(hostStub: HostApi): void {
    this.#proxyKv = createProxyKv(hostStub);
    installFetchProxy(hostStub);

    // Register built-in tools alongside custom tools
    if (this.#agent.builtinTools?.length) {
      const builtinDefs = getBuiltinToolDefs(this.#agent.builtinTools, {
        vectorSearch: async (query, topK) => {
          return await withTimeout(hostStub.vectorSearch({ query, topK }), FETCH_TIMEOUT_MS);
        },
      });
      for (const [name, def] of Object.entries(builtinDefs)) {
        this.#toolHandlers.set(name, def);
      }
    }
  }

  /**
   * Set environment variables and return this target as a scoped capability.
   *
   * The host calls this once after session creation. Returning `this`
   * passes it by reference via capnweb — the host gets a stub that
   * guarantees env is set before any pipelined calls execute.
   */
  withEnv(env: Record<string, string>): this {
    this.#mergedEnv = { ...this.#mergedEnv, ...env };
    return this;
  }

  getConfig(): WorkerConfig {
    // Include all tools (custom + built-in) in schemas
    const toolSchemas: ToolSchema[] = [];
    for (const [name, def] of this.#toolHandlers) {
      toolSchemas.push({
        name,
        description: def.description,
        parameters: z.toJSONSchema(def.parameters ?? EMPTY_PARAMS) as ToolSchema["parameters"],
      });
    }
    const config: AgentConfig = {
      name: this.#agent.name,
      instructions: this.#agent.instructions,
      greeting: this.#agent.greeting,
      voice: this.#agent.voice,
    };
    if (this.#agent.sttPrompt !== undefined) {
      config.sttPrompt = this.#agent.sttPrompt;
    }
    if (typeof this.#agent.maxSteps !== "function") {
      config.maxSteps = this.#agent.maxSteps;
    }
    if (this.#agent.toolChoice !== undefined) {
      config.toolChoice = this.#agent.toolChoice;
    }
    if (this.#agent.builtinTools) {
      config.builtinTools = [...this.#agent.builtinTools];
    }
    if (this.#agent.activeTools) {
      config.activeTools = [...this.#agent.activeTools];
    }
    return { config, toolSchemas };
  }

  async executeTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    sessionId: string | undefined,
    messages: readonly Message[] | undefined,
  ): Promise<string> {
    const tool = this.#toolHandlers.get(name);
    if (!tool) return `Error: Unknown tool "${name}"`;
    return await executeToolCall(name, args, {
      tool,
      env: this.#mergedEnv,
      sessionId,
      state: this.#getState(sessionId ?? ""),
      kv: this.#proxyKv!,
      messages,
    });
  }

  async onConnect(sessionId: string): Promise<void> {
    await this.#agent.onConnect?.(this.#makeCtx(sessionId));
  }

  async onDisconnect(sessionId: string): Promise<void> {
    await this.#agent.onDisconnect?.(this.#makeCtx(sessionId));
    this.#sessions.delete(sessionId);
  }

  async onTurn(sessionId: string, text: string): Promise<void> {
    await this.#agent.onTurn?.(text, this.#makeCtx(sessionId));
  }

  onError(sessionId: string, error: string): void {
    this.#agent.onError?.(new Error(error), this.#makeCtx(sessionId));
  }

  async onStep(
    sessionId: string,
    step: Parameters<NonNullable<AgentDef["onStep"]>>[0],
  ): Promise<void> {
    await this.#agent.onStep?.(step, this.#makeCtx(sessionId));
  }

  async resolveTurnConfig(
    sessionId: string,
  ): Promise<{ maxSteps?: number; activeTools?: string[] } | null> {
    let maxSteps: number | undefined;
    let activeTools: string[] | undefined;

    if (typeof this.#agent.maxSteps === "function") {
      maxSteps = (await this.#agent.maxSteps(this.#makeCtx(sessionId))) ?? undefined;
    }

    if (this.#agent.onBeforeStep) {
      const result = await this.#agent.onBeforeStep(0, this.#makeCtx(sessionId));
      activeTools = result?.activeTools;
    }

    if (maxSteps === undefined && activeTools === undefined) return null;
    const result: { maxSteps?: number; activeTools?: string[] } = {};
    if (maxSteps !== undefined) result.maxSteps = maxSteps;
    if (activeTools !== undefined) result.activeTools = activeTools;
    return result;
  }

  #getState(sessionId: string): unknown {
    if (!this.#sessions.has(sessionId) && this.#agent.state) {
      this.#sessions.set(sessionId, this.#agent.state());
    }
    return this.#sessions.get(sessionId) ?? {};
  }

  #makeCtx(sessionId: string): HookContext {
    const proxyKv = this.#proxyKv;
    return {
      sessionId,
      env: { ...this.#mergedEnv },
      state: this.#getState(sessionId) as Record<string, unknown>,
      get kv() {
        if (!proxyKv) throw new Error("KV not available");
        return proxyKv;
      },
    };
  }
}

/**
 * Initialize the worker-side Cap'n Web RPC endpoint for an agent.
 *
 * Both sides exchange targets at session creation: the worker passes its
 * {@linkcode AgentWorkerTarget} and receives a stub for the host's API.
 * No separate init handshake is needed.
 *
 * @param agent - The agent definition returned by `defineAgent()`.
 */
export function initWorker(agent: AgentDef, port?: MessagePort): void {
  const endpoint = port ?? asMessagePort(self);
  const workerTarget = new AgentWorkerTarget(agent);

  // Both sides pass their target — worker gets host stub, host gets worker stub
  const hostStub = newMessagePortRpcSession<HostApi>(endpoint, workerTarget);
  workerTarget.setHostApi(hostStub);
}
