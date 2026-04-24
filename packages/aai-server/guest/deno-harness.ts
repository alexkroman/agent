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
 * - Guest -> host: fetch/request (proxied fetch via RPC)
 * - Host -> guest: fetch/response-start, fetch/response-chunk,
 *                  fetch/response-end, fetch/response-error (streamed response)
 *
 * ZERO workspace imports -- this file is entirely self-contained.
 *
 * Run with: deno run --no-prompt deno-harness.ts
 */

// ---- Inline TextLineStream (avoids jsr: import that can't be bundled) -------

/** Splits a text stream into lines by \n. Minimal replacement for @std/streams TextLineStream. */
export class TextLineStream extends TransformStream<string, string> {
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

// Minimal Vector-shaped adapter passed to tool contexts (mirrors sdk/vector.ts).
type VectorAdapterRecord = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
};
type VectorAdapterMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[];
};
type VectorAdapterQuery = {
  vector?: number[];
  id?: string;
  topK?: number;
  filter?: Record<string, unknown>;
  includeValues?: boolean;
  includeMetadata?: boolean;
  namespace?: string;
};
type VectorAdapter = {
  upsert(
    records: VectorAdapterRecord | VectorAdapterRecord[],
    options?: { namespace?: string },
  ): Promise<void>;
  query(query: VectorAdapterQuery): Promise<VectorAdapterMatch[]>;
  delete(
    ids: string | string[],
    options?: { namespace?: string; deleteAll?: boolean },
  ): Promise<void>;
  fetch(ids: string | string[], options?: { namespace?: string }): Promise<VectorAdapterRecord[]>;
};

type ToolContext = {
  env: Readonly<Record<string, string>>;
  state: Record<string, unknown>;
  kv: KvAdapter;
  vector: VectorAdapter;
  sessionId: string;
  messages: readonly Message[];
  send(event: string, data: unknown): void;
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

export function writeMessage(msg: JsonRpcMessage): void {
  const line = `${JSON.stringify(msg)}\n`;
  Deno.stdout.writeSync(encoder.encode(line));
}

export function sendResponse(id: number | string, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

export function sendError(id: number | string, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---- KV proxy ---------------------------------------------------------------

let kvRequestId = 1;

/**
 * Pending KV responses, keyed by request id.
 * The main NDJSON loop resolves these when the host replies.
 */
export const pendingKvRequests = new Map<
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

// ---- Fetch proxy ---------------------------------------------------------------

type PendingFetch = {
  resolve: (response: Response) => void;
  reject: (err: Error) => void;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  chunks: Uint8Array[];
};

const pendingFetches = new Map<string, PendingFetch>();

const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

function handleFetchNotification(method: string, params: unknown): void {
  const p = params as { id: string; [key: string]: unknown };
  const pending = pendingFetches.get(p.id);
  if (!pending) return;

  switch (method) {
    case "fetch/response-start":
      pending.status = p.status as number;
      pending.statusText = p.statusText as string;
      pending.headers = p.headers as Record<string, string>;
      break;

    case "fetch/response-chunk":
      pending.chunks.push(base64ToBytes(p.data as string));
      break;

    case "fetch/response-end": {
      pendingFetches.delete(p.id);
      const totalLen = pending.chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const body = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of pending.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      pending.resolve(
        new Response(body.length > 0 ? body : null, {
          status: pending.status ?? 200,
          statusText: pending.statusText ?? "",
          headers: pending.headers ?? {},
        }),
      );
      break;
    }

    case "fetch/response-error":
      pendingFetches.delete(p.id);
      pending.reject(new TypeError(`fetch failed: ${p.message}`));
      break;

    default:
      break;
  }
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init);

  let bodyB64: string | null = null;
  if (req.body) {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new TypeError(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} byte limit`);
    }
    bodyB64 = bytesToBase64(new Uint8Array(buf));
  }

  // Send fetch/request RPC — host returns { id }
  const rpcResponse = (await kvRequest("fetch/request", {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    body: bodyB64,
  })) as { id: string };

  // Register a pending fetch and wait for response notifications
  return new Promise<Response>((resolve, reject) => {
    pendingFetches.set(rpcResponse.id, { resolve, reject, chunks: [] });
  });
};

// ---- Client send --------------------------------------------------------------

function sendToClient(sessionId: string, event: string, data: unknown): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "client/send",
    params: { sessionId, event, data },
  } as JsonRpcNotification);
}

// Adapt KvInterface to the Kv shape expected by ToolContext
export function makeKvAdapter(): KvAdapter {
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

// ---- Vector proxy -----------------------------------------------------------

/**
 * Adapter that forwards vector-store operations to the host via the same
 * NDJSON request channel used for `kv/*`. Throws a clear error when the
 * agent didn't configure a vector store — the host responds with a JSON-RPC
 * error which we surface as-is.
 */
export function makeVectorAdapter(): VectorAdapter {
  return {
    async upsert(records, options): Promise<void> {
      const arr = Array.isArray(records) ? records : [records];
      await kvRequest("vector/upsert", {
        records: arr,
        ...(options?.namespace ? { namespace: options.namespace } : {}),
      });
    },
    async query(query: VectorAdapterQuery): Promise<VectorAdapterMatch[]> {
      const result = (await kvRequest("vector/query", query)) as VectorAdapterMatch[] | undefined;
      return result ?? [];
    },
    async delete(ids, options): Promise<void> {
      const arr = Array.isArray(ids) ? ids : [ids];
      await kvRequest("vector/delete", {
        ids: arr,
        ...(options?.namespace ? { namespace: options.namespace } : {}),
        ...(options?.deleteAll ? { deleteAll: true } : {}),
      });
    },
    async fetch(ids, options): Promise<VectorAdapterRecord[]> {
      const arr = Array.isArray(ids) ? ids : [ids];
      const result = (await kvRequest("vector/fetch", {
        ids: arr,
        ...(options?.namespace ? { namespace: options.namespace } : {}),
      })) as VectorAdapterRecord[] | undefined;
      return result ?? [];
    },
  };
}

// ---- Agent env --------------------------------------------------------------

let _bundleEnv: Readonly<Record<string, string>> = Object.freeze({});

/** Returns agent env vars from the bundle message. */
function getAgentEnv(): Readonly<Record<string, string>> {
  return _bundleEnv;
}

// ---- Session state ----------------------------------------------------------

/**
 * Per-session state map. Lazily initialised from agent.state() factory per
 * session. Deep-cloned via JSON round-trip to ensure isolation.
 */
export function createSessionStateMap(initState?: () => Record<string, unknown>) {
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

export async function executeTool(
  agent: AgentDef,
  req: ToolCallRequest,
  sessionState: ReturnType<typeof createSessionStateMap>,
): Promise<ToolCallResponse | ToolCallErrorResponse> {
  const tool = agent.tools[req.name];
  if (!tool) {
    return { error: `Unknown tool: ${req.name}` };
  }

  const kvAdapter = makeKvAdapter();
  const vectorAdapter = makeVectorAdapter();
  const ctx: ToolContext = {
    env: getAgentEnv(),
    state: sessionState.get(req.sessionId),
    kv: kvAdapter,
    vector: vectorAdapter,
    messages: req.messages,
    sessionId: req.sessionId,
    send: (event, data) => sendToClient(req.sessionId, event, data),
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
  _bundleEnv = Object.freeze({ ...env });

  const dataUrl = `data:application/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object") {
    throw new Error("Agent bundle must export an object");
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
export async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
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
export function handleKvResponse(resp: JsonRpcResponse): void {
  const pending = pendingKvRequests.get(resp.id);
  if (!pending) return;
  pendingKvRequests.delete(resp.id);
  if (resp.error) {
    pending.reject(new Error(resp.error.message));
  } else {
    pending.resolve(resp.result);
  }
}

export function handleNotification(notif: JsonRpcNotification, state: HarnessState): void {
  if (notif.method === "shutdown") Deno.exit(0);
  if (notif.method === "session/end" && state.sessionState) {
    const params = notif.params as { sessionId?: string } | undefined;
    if (params?.sessionId) state.sessionState.delete(params.sessionId);
  }
  if (notif.method.startsWith("fetch/response-")) {
    handleFetchNotification(notif.method, notif.params);
  }
}

export function dispatchMessage(msg: JsonRpcMessage, state: HarnessState): void {
  // Incoming response to a kv/* request we sent
  if ("id" in msg && !("method" in msg)) {
    handleKvResponse(msg as JsonRpcResponse);
    return;
  }
  // Notification (no id)
  if (!("id" in msg)) {
    handleNotification(msg as JsonRpcNotification, state);
    return;
  }
  // Request -- handle concurrently so the loop reads the next line immediately
  const req = msg as JsonRpcRequest;
  void handleRequest(req, state).catch((err) => {
    sendError(req.id, -32_603, err instanceof Error ? err.message : String(err));
  });
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

    dispatchMessage(msg, state);
  }
}

// Only run main loop when executed directly by Deno (not when imported in tests).
if (typeof Deno !== "undefined" && Deno.stdin) {
  main().catch((err) => {
    console.error("Harness fatal error:", err);
    Deno.exit(1);
  });
}
