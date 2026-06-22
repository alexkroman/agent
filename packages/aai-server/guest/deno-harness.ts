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
 * ZERO workspace imports -- the harness and its `harness-*.ts` siblings are
 * entirely self-contained. The siblings are inlined by the bundler into one
 * artifact for production, and loaded by Deno as static sibling imports in
 * dev (static imports need no extra permissions).
 *
 * Run with: deno run --no-prompt deno-harness.ts
 */

import {
  handleFetchNotification,
  handleHostResponse,
  makeKvAdapter,
  makeVectorAdapter,
  sendError,
  sendResponse,
  sendToClient,
} from "./harness-rpc.ts";
import type {
  AgentDef,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  Message,
  ToolContext,
} from "./harness-types.ts";

// Re-export the host-RPC surface so existing consumers/tests can keep
// importing it from `./deno-harness.ts`.
export {
  handleHostResponse,
  handleKvResponse,
  makeKvAdapter,
  makeVectorAdapter,
  pendingHostRequests,
  pendingKvRequests,
  sendError,
  sendResponse,
  writeMessage,
} from "./harness-rpc.ts";

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
  // Incoming response to a host RPC request we sent (kv/*, vector/*, etc.)
  if ("id" in msg && !("method" in msg)) {
    handleHostResponse(msg as JsonRpcResponse);
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
