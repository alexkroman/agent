// Copyright 2025 the AAI authors. MIT license.
/// <reference lib="deno.ns" />
/// <reference lib="deno.window" />
/**
 * Deno guest-side harness entrypoint.
 *
 * Reads NDJSON from stdin, dispatches JSON-RPC 2.0 messages, and writes
 * NDJSON responses to stdout. Designed to run inside a Modal Sandbox.
 *
 * Protocol overview:
 * - Host -> guest: bundle/load, tool/execute, shutdown, ping (liveness
 *   heartbeat — carries no payload; receiving any line feeds the orphan
 *   watchdog, so `ping` needs no handler branch)
 * - Guest -> host: db/query (proxied ctx.db queries), vector/* (proxied Vector)
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
  createSessionMessagesCache,
  MESSAGES_DESYNC_ERROR,
  type MessagesMode,
  type SessionMessagesCache,
} from "./harness-messages.ts";
import {
  dbAdapter,
  errMsg,
  generateAdapter,
  handleFetchNotification,
  handleHostResponse,
  rejectAllPendingHostRequests,
  sendError,
  sendResponse,
  sendToClient,
  vectorAdapter,
  withTimeout,
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
import { createOrphanWatchdog } from "./harness-watchdog.ts";
import {
  HARNESS_ORPHAN_TIMEOUT_MS,
  RUN_CODE_TIMEOUT_MS,
  STORAGE_DISABLED_MESSAGE,
  TOOL_TIMEOUT_MS,
} from "./limits.ts";

// Re-export the host-RPC surface the harness tests exercise through this
// module.
export { handleHostResponse, vectorAdapter } from "./harness-rpc.ts";

// ---- Inline TextLineStream (avoids jsr: import that can't be bundled) -------

/** Splits a text stream into lines by \n. Minimal replacement for @std/streams TextLineStream. */
export class TextLineStream extends TransformStream<string, string> {
  constructor() {
    let buf = "";
    // Index into `buf` where the next newline scan starts. Everything before
    // it has already been scanned, so each incoming chunk is scanned exactly
    // once — a naive `buf.split("\n")` rescans the whole buffer per chunk,
    // which is quadratic on huge single-line payloads like the 10 MB
    // bundle/load message.
    let searchFrom = 0;
    super({
      transform(chunk, controller) {
        buf += chunk;
        let idx = buf.indexOf("\n", searchFrom);
        if (idx !== -1) {
          let start = 0;
          do {
            controller.enqueue(buf.slice(start, idx));
            start = idx + 1;
            idx = buf.indexOf("\n", start);
          } while (idx !== -1);
          buf = buf.slice(start);
        }
        // The remaining buffer holds no newline — resume scanning at its end.
        searchFrom = buf.length;
      },
      flush(controller) {
        if (buf) controller.enqueue(buf);
      },
    });
  }
}

// ---- Agent env --------------------------------------------------------------

let _bundleEnv: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Whether storage (ctx.db) is enabled for the loaded bundle — set by the
 * `storageEnabled` bundle/load param. Off means a ctx.db access throws the
 * same guidance the SDK's tool-executor gives (see the getter in
 * `executeTool`), so `aai dev` and the platform read identically.
 */
let _storageEnabled = false;

// ---- Session state ----------------------------------------------------------

/**
 * Per-session state map. Lazily initialised from agent.state() factory per
 * session. Deep-cloned via structuredClone to ensure isolation.
 */
export function createSessionStateMap(initState?: () => Record<string, unknown>) {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get(sessionId: string): Record<string, unknown> {
      if (!map.has(sessionId)) {
        const initial = initState ? initState() : {};
        map.set(sessionId, structuredClone(initial));
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

// ---- run_code builtin -------------------------------------------------------

/**
 * Execute agent-supplied JavaScript for the `run_code` builtin.
 *
 * `run_code` runs HERE, inside the Deno guest, not on the host. The Modal
 * sandbox plus Deno's permission model (`--no-prompt`, no net/fs/run) ARE the
 * security boundary, so we deliberately do NOT attempt in-process `node:vm`
 * isolation — that was never a real boundary and was escapable via the host
 * `Function` constructor. Code here has the same authority as the rest of the
 * sandboxed agent bundle and nothing more; an escape lands in a process that
 * is already confined.
 *
 * Output is captured through an injected `console` argument rather than a
 * global monkey-patch, so concurrent run_code calls never clobber each other.
 */
async function runCode(code: string): Promise<string | { error: string }> {
  const output: string[] = [];
  const push = (...args: unknown[]) => output.push(args.map(String).join(" "));
  const sandboxConsole = { log: push, info: push, warn: push, error: push, debug: push };

  try {
    // Async wrapper so user code can use top-level `await`.
    const factory = new Function("console", `return (async () => {\n${code}\n})();`) as (
      c: typeof sandboxConsole,
    ) => Promise<unknown>;

    await withTimeout(factory(sandboxConsole), RUN_CODE_TIMEOUT_MS, "run_code");

    const text = output.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err) {
    return { error: errMsg(err) };
  }
}

// ---- Tool execution ---------------------------------------------------------

type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  /** Full history, or (in append mode) only the tail after `messagesBase`. */
  messages?: Message[];
  /** Absent means "full" — callers predating the delta protocol send that. */
  messagesMode?: MessagesMode;
  /** Append mode: history length the guest's cache must already have. */
  messagesBase?: number;
};

// No `state` field: the guest's own sessionState map is the source of truth
// and the host only ever reads `result`, so shipping the full per-session
// state back on every tool call was pure wire-format dead weight.
type ToolCallResponse = {
  result: string;
};

type ToolCallErrorResponse = {
  error: string;
};

export async function executeTool(
  agent: AgentDef,
  req: ToolCallRequest,
  sessionState: ReturnType<typeof createSessionStateMap>,
  sessionMessages: SessionMessagesCache,
): Promise<ToolCallResponse | ToolCallErrorResponse> {
  // Reconstruct this call's conversation history from the delta the host
  // sent (see harness-messages.ts). A desync answer makes the host retry
  // with full history, so it must never reach the tool as its result.
  const messages = sessionMessages.apply(
    req.sessionId,
    req.messages ?? [],
    req.messagesMode,
    req.messagesBase,
  );
  if (messages === null) {
    return { error: MESSAGES_DESYNC_ERROR };
  }

  // The run_code builtin is not part of the agent bundle; execute it directly
  // in this sandboxed guest (see runCode) rather than on the host.
  if (req.name === "run_code") {
    const code = typeof req.args?.code === "string" ? req.args.code : "";
    const result = await runCode(code);
    if (typeof result === "object" && result !== null && "error" in result) {
      return { error: result.error };
    }
    return { result };
  }

  const tool = agent.tools[req.name];
  if (!tool) {
    return { error: `Unknown tool: ${req.name}` };
  }

  const ctx: ToolContext = {
    env: _bundleEnv,
    state: sessionState.get(req.sessionId),
    // Lazy getter: only an actual ctx.db access should fail when storage is
    // disabled — constructing the context must not.
    get db() {
      if (!_storageEnabled) throw new Error(STORAGE_DISABLED_MESSAGE);
      return dbAdapter;
    },
    vector: vectorAdapter,
    generate: generateAdapter,
    messages,
    sessionId: req.sessionId,
    send: (event, data) => void sendToClient(req.sessionId, event, data),
  };

  try {
    // Parse inside the try: invalid LLM-supplied args must surface as a
    // `{ error }` tool result (which the LLM can repair), not as a JSON-RPC
    // protocol error.
    const parsed =
      tool.parameters && typeof tool.parameters.parse === "function"
        ? tool.parameters.parse(req.args)
        : req.args;

    const result = await withTimeout(
      Promise.resolve(tool.execute(parsed, ctx)),
      TOOL_TIMEOUT_MS,
      `Tool "${req.name}"`,
    );
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
    };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

// ---- bundle/load ------------------------------------------------------------

/**
 * Import raw JS source as an ES module (no Function() evaluation, top-level
 * await supported).
 *
 * Under Deno the code goes through a `blob:` object URL: percent-encoding a
 * bundle of up to 10 MB into a `data:` URL costs a full encodeURIComponent
 * pass on the guest's single event loop plus an extra in-memory copy inside
 * the 64 MB cgroup, all inside the timed cold-start bundle/load round trip.
 * The object URL is revoked once the import settles (the module registry
 * keeps the loaded module alive). Node — where the unit tests run — cannot
 * import `blob:` modules, so it keeps the `data:` URL path; real Deno is
 * detected via `Deno.version.deno`, which the test shims don't define.
 */
async function importBundleModule(code: string): Promise<Record<string, unknown>> {
  const deno = (globalThis as { Deno?: { version?: { deno?: unknown } } }).Deno;
  if (typeof deno?.version?.deno === "string") {
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    try {
      return await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  return await import(`data:application/javascript,${encodeURIComponent(code)}`);
}

/**
 * Load an agent ESM bundle delivered as raw JS source code.
 *
 * Bundles built by the browser studio also export `__aaiConfig` — the agent
 * config extracted *inside* the bundle (by `@alexkroman1/aai/manifest`
 * helpers bundled in). Returning it lets the host obtain the config without
 * ever evaluating user code outside the sandbox.
 */
async function loadBundle(
  code: string,
  env: Record<string, string>,
  storageEnabled: boolean,
): Promise<{ agent: AgentDef; config?: unknown }> {
  _bundleEnv = Object.freeze({ ...env });
  _storageEnabled = storageEnabled;

  const mod = await importBundleModule(code);
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object") {
    throw new Error("Agent bundle must export an object");
  }

  const config = (mod as { __aaiConfig?: unknown }).__aaiConfig;
  return config === undefined ? { agent } : { agent, config };
}

// ---- Main dispatch loop -----------------------------------------------------

/** Mutable state shared across requests within a single harness instance. */
type HarnessState = {
  agent: AgentDef | null;
  sessionState: ReturnType<typeof createSessionStateMap> | null;
  sessionMessages: SessionMessagesCache | null;
};

/** Resolve and settle a single incoming JSON-RPC request. */
export async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
  switch (req.method) {
    case "bundle/load": {
      if (!req.params || typeof (req.params as Record<string, unknown>).code !== "string") {
        await sendError(req.id, -32_602, "bundle/load requires { code: string, env: {} }");
        break;
      }
      const params = req.params as {
        code: string;
        env: Record<string, string>;
        storageEnabled?: boolean;
      };
      const loaded = await loadBundle(
        params.code,
        params.env ?? {},
        params.storageEnabled === true,
      );
      state.agent = loaded.agent;
      state.sessionState = createSessionStateMap(
        typeof state.agent.state === "function" ? state.agent.state : undefined,
      );
      state.sessionMessages = createSessionMessagesCache();
      await sendResponse(req.id, {
        ok: true,
        ...(loaded.config !== undefined && { config: loaded.config }),
      });
      break;
    }

    case "tool/execute": {
      if (!(state.agent && state.sessionState && state.sessionMessages)) {
        await sendError(req.id, -32_000, "Agent not loaded");
        break;
      }
      const toolResult = await executeTool(
        state.agent,
        req.params as ToolCallRequest,
        state.sessionState,
        state.sessionMessages,
      );
      await sendResponse(req.id, toolResult);
      break;
    }

    default:
      await sendError(req.id, -32_601, `Method not found: ${req.method}`);
  }
}

export function handleNotification(notif: JsonRpcNotification, state: HarnessState): void {
  // The frame came off the wire — a malformed notification with no string
  // `method` must be ignored, not allowed to throw and kill the main loop.
  if (typeof notif?.method !== "string") return;
  if (notif.method === "shutdown") Deno.exit(0);
  if (notif.method === "session/end") {
    const params = notif.params as { sessionId?: string } | undefined;
    if (params?.sessionId) {
      state.sessionState?.delete(params.sessionId);
      state.sessionMessages?.delete(params.sessionId);
    }
  }
  if (notif.method.startsWith("fetch/response-")) {
    handleFetchNotification(notif.method, notif.params);
  }
}

export function dispatchMessage(msg: JsonRpcMessage, state: HarnessState): void {
  // Incoming response to a host RPC request we sent (db/query, vector/*, etc.)
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
    void sendError(req.id, -32_603, errMsg(err));
  });
}

async function main(): Promise<void> {
  const lineStream = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  const state: HarnessState = { agent: null, sessionState: null, sessionMessages: null };

  const watchdog = createOrphanWatchdog({
    onOrphaned: () => {
      console.error(
        `Harness orphaned: no host traffic for ${HARNESS_ORPHAN_TIMEOUT_MS}ms; exiting`,
      );
      Deno.exit(3);
    },
  });

  for await (const line of lineStream) {
    watchdog.touch();
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

  // stdin closed — the host is gone. Nothing pending can ever be answered,
  // so fail it all fast, then exit outright: a loaded bundle may hold its own
  // timers/intervals, and waiting for the event loop to drain would leave the
  // process (and its Modal sandbox) alive at the host's expense.
  rejectAllPendingHostRequests("Connection closed");
  Deno.exit(0);
}

// Only run main loop when executed directly by Deno (not when imported in tests).
if (typeof Deno !== "undefined" && Deno.stdin) {
  main().catch((err) => {
    console.error("Harness fatal error:", err);
    Deno.exit(1);
  });
}
