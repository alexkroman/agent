// Copyright 2025 the AAI authors. MIT license.
/// <reference lib="deno.ns" />
/// <reference lib="deno.window" />
/**
 * Deno guest-side harness entrypoint.
 *
 * Reads NDJSON from stdin, dispatches JSON-RPC 2.0 messages, and writes
 * NDJSON responses to stdout. Designed to run inside a gVisor sandbox.
 *
 * Protocol overview:
 * - Host -> guest: bundle/load, tool/execute, shutdown
 * - Guest -> host: kv/get, kv/set, kv/del (proxied KV requests)
 *
 * ZERO workspace imports -- this file is entirely self-contained.
 *
 * Run with: deno run --allow-env --no-prompt deno-harness.ts
 */

// ---- Inline TextLineStream (avoids jsr: import that can't be bundled) -------

/** Splits a text stream into lines by \n. Minimal replacement for @std/streams TextLineStream. */
class TextLineStream extends TransformStream<string, string> {
  constructor() {
    let buf = "";
    super({
      transform(chunk, controller) {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(line);
      },
      flush(controller) {
        if (buf) controller.enqueue(buf);
      },
    });
  }
}

// ---- Inline type definitions ------------------------------------------------

type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
};

type KvInterface = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>;
  del(key: string): Promise<void>;
};

// Minimal Kv-shaped adapter passed to tool contexts
type KvAdapter = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  delete(key: string | string[]): Promise<void>;
};

type ToolContext = {
  env: Readonly<Record<string, string>>;
  state: Record<string, unknown>;
  kv: KvAdapter;
  sessionId: string;
  messages: readonly Message[];
};

type ToolDef = {
  description: string;
  parameters?: { parse(args: unknown): unknown };
  execute(args: unknown, ctx: ToolContext): Promise<unknown> | unknown;
};

type AgentDef = {
  name: string;
  systemPrompt: string;
  greeting: string;
  tools: Record<string, ToolDef>;
  state?: () => Record<string, unknown>;
  maxSteps?: number;
};

// ---- JSON-RPC 2.0 message shapes --------------------------------------------

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ---- NDJSON I/O -------------------------------------------------------------

const encoder = new TextEncoder();

function writeMessage(msg: JsonRpcMessage): void {
  const line = `${JSON.stringify(msg)}\n`;
  Deno.stdout.writeSync(encoder.encode(line));
}

function sendResponse(id: number | string, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---- KV proxy ---------------------------------------------------------------

let kvRequestId = 1;

/**
 * Pending KV responses, keyed by request id.
 * The main NDJSON loop resolves these when the host replies.
 */
const pendingKvRequests = new Map<
  number | string,
  { resolve: (value: unknown) => void; reject: (err: unknown) => void }
>();

/**
 * Send a KV RPC request to the host and wait for its response.
 */
function kvRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = kvRequestId++;
  return new Promise((resolve, reject) => {
    pendingKvRequests.set(id, { resolve, reject });
    writeMessage({ jsonrpc: "2.0", id, method, params });
  });
}

const kv: KvInterface = {
  async get(key: string): Promise<unknown> {
    const resp = (await kvRequest("kv/get", { key })) as { value?: unknown };
    return resp?.value ?? null;
  },
  async set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void> {
    await kvRequest("kv/set", {
      key,
      value,
      ...(opts?.expireIn !== undefined ? { expireIn: opts.expireIn } : {}),
    });
  },
  async del(key: string): Promise<void> {
    await kvRequest("kv/del", { key });
  },
};

// Adapt KvInterface to the Kv shape expected by ToolContext
function makeKvAdapter(): KvAdapter {
  return {
    get: <T = unknown>(key: string) => kv.get(key) as Promise<T | null>,
    set: (key: string, value: unknown, options?: { expireIn?: number }) =>
      kv.set(key, value, options),
    delete: (key: string | string[]): Promise<void> => {
      if (Array.isArray(key)) {
        return Promise.all(key.map((k) => kv.del(k))).then(() => undefined);
      }
      return kv.del(key);
    },
  };
}

// ---- Agent env --------------------------------------------------------------

const AAI_ENV_PREFIX = "AAI_ENV_";
let _agentEnv: Readonly<Record<string, string>> | null = null;

/** Returns agent env vars (AAI_ENV_ prefix stripped). Cached after first call. */
function getAgentEnv(): Readonly<Record<string, string>> {
  if (!_agentEnv) {
    _agentEnv = Object.freeze(
      Object.fromEntries(
        Object.entries(Deno.env.toObject())
          .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
          .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v]),
      ),
    ) as Readonly<Record<string, string>>;
  }
  // _agentEnv is guaranteed non-null after the if block above
  return _agentEnv as Readonly<Record<string, string>>;
}

/** Reset cached env (call after setting new AAI_ENV_ vars). */
function resetAgentEnv(): void {
  _agentEnv = null;
}

// ---- Session state ----------------------------------------------------------

/**
 * Per-session state map. Lazily initialised from agent.state() factory per
 * session. Deep-cloned via JSON round-trip to ensure isolation.
 */
function createSessionStateMap(initState?: () => Record<string, unknown>) {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get(sessionId: string): Record<string, unknown> {
      if (!map.has(sessionId)) {
        const initial = initState ? initState() : {};
        // JSON round-trip for a deep clone
        map.set(sessionId, JSON.parse(JSON.stringify(initial)));
      }
      // map.has() guarantees the key exists after the block above
      return map.get(sessionId) as Record<string, unknown>;
    },
    set(sessionId: string, state: Record<string, unknown>): void {
      map.set(sessionId, state);
    },
    delete(sessionId: string): boolean {
      return map.delete(sessionId);
    },
  };
}

// ---- Tool execution ---------------------------------------------------------

const TOOL_TIMEOUT_MS = 30_000;

type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: Message[];
};

type ToolCallResponse = {
  result: string;
  state: Record<string, unknown>;
};

type ToolCallErrorResponse = {
  error: string;
};

async function executeTool(
  agent: AgentDef,
  req: ToolCallRequest,
  sessionState: ReturnType<typeof createSessionStateMap>,
): Promise<ToolCallResponse | ToolCallErrorResponse> {
  const tool = agent.tools[req.name];
  if (!tool) {
    return { error: `Unknown tool: ${req.name}` };
  }

  const kvAdapter = makeKvAdapter();
  const ctx: ToolContext = {
    env: getAgentEnv(),
    state: sessionState.get(req.sessionId),
    kv: kvAdapter,
    messages: req.messages,
    sessionId: req.sessionId,
  };

  const parsed =
    tool.parameters && typeof tool.parameters.parse === "function"
      ? tool.parameters.parse(req.args)
      : req.args;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      tool.execute(parsed, ctx),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Tool "${req.name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
          TOOL_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
      state: ctx.state as Record<string, unknown>,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- bundle/load ------------------------------------------------------------

/**
 * Load an agent ESM bundle delivered as raw JS source code.
 *
 * The code is imported via a data: URL so Deno treats it as an ES module.
 * This avoids Function() evaluation and supports top-level await in the bundle.
 */
async function loadBundle(code: string, env: Record<string, string>): Promise<AgentDef> {
  // Set agent env vars before loading so the bundle can read them
  for (const [key, value] of Object.entries(env)) {
    Deno.env.set(`${AAI_ENV_PREFIX}${key}`, value);
  }
  resetAgentEnv();

  const dataUrl = `data:application/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  return agent;
}

// ---- Main dispatch loop -----------------------------------------------------

/** Mutable state shared across requests within a single harness instance. */
type HarnessState = {
  agent: AgentDef | null;
  sessionState: ReturnType<typeof createSessionStateMap> | null;
};

/** Resolve and settle a single incoming JSON-RPC request. */
async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
  switch (req.method) {
    case "bundle/load": {
      if (!req.params || typeof (req.params as Record<string, unknown>).code !== "string") {
        sendError(req.id, -32_602, "bundle/load requires { code: string, env: {} }");
        break;
      }
      const params = req.params as { code: string; env: Record<string, string> };
      state.agent = await loadBundle(params.code, params.env ?? {});
      state.sessionState = createSessionStateMap(
        typeof state.agent.state === "function" ? state.agent.state : undefined,
      );
      sendResponse(req.id, { ok: true });
      break;
    }

    case "tool/execute": {
      if (!(state.agent && state.sessionState)) {
        sendError(req.id, -32_000, "Agent not loaded");
        break;
      }
      const toolResult = await executeTool(
        state.agent,
        req.params as ToolCallRequest,
        state.sessionState,
      );
      sendResponse(req.id, toolResult);
      break;
    }

    default:
      sendError(req.id, -32_601, `Method not found: ${req.method}`);
  }
}

/** Dispatch an incoming response to a pending KV request. */
function handleKvResponse(resp: JsonRpcResponse): void {
  const pending = pendingKvRequests.get(resp.id);
  if (!pending) return;
  pendingKvRequests.delete(resp.id);
  if (resp.error) {
    pending.reject(new Error(resp.error.message));
  } else {
    pending.resolve(resp.result);
  }
}

async function main(): Promise<void> {
  const lineStream = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  const state: HarnessState = { agent: null, sessionState: null };

  for await (const line of lineStream) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // Malformed JSON -- skip line
      continue;
    }

    // Incoming response to a kv/* request we sent
    if ("id" in msg && !("method" in msg)) {
      handleKvResponse(msg as JsonRpcResponse);
      continue;
    }

    // Notification (no id)
    if (!("id" in msg)) {
      const notif = msg as JsonRpcNotification;
      if (notif.method === "shutdown") Deno.exit(0);
      continue;
    }

    // Request -- handle concurrently so the loop reads the next line immediately
    const req = msg as JsonRpcRequest;
    void handleRequest(req, state).catch((err) => {
      sendError(req.id, -32_603, err instanceof Error ? err.message : String(err));
    });
  }
}

main().catch((err) => {
  console.error("Harness fatal error:", err);
  Deno.exit(1);
});
