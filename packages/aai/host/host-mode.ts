// Copyright 2026 the AAI authors. MIT license.
/**
 * Host mode — run a per-connection agent supplied by the client instead of the
 * deployed agent.
 *
 * A host-mode WebSocket connection begins with a single `config` frame that
 * carries a {@link HostConfig} block (`systemPrompt`, optional `greeting`, and
 * relayed `tools`). Because the deployed-agent flow builds the session's
 * transport synchronously on socket-open (before any client message can
 * arrive — see HOST_MODE_CONTRACT.md §1), host mode DEFERS
 * `runtime.startSession` until that first frame lands: {@link startHostSession}
 * holds the raw socket, waits for the handshake, then builds a fresh, single-use
 * {@link Runtime} whose tools are executed by a {@link createRelayExecuteTool}
 * relay. The relay emits `tool_call` frames to the client and resolves each call
 * when the matching inbound `tool_result` arrives.
 */

import type { ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import {
  DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_RELAY_TOOL_TIMEOUT_MS,
} from "../sdk/constants.ts";
import type { ClientEvent, HostConfig } from "../sdk/protocol.ts";
import { HostConfigMessageSchema } from "../sdk/protocol.ts";
import type { AgentDef } from "../sdk/types.ts";
import { errorMessage, safeJsonParse, toolError } from "../sdk/utils.ts";
import { createRuntime, type RuntimeOptions, type SessionStartOptions } from "./runtime.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import { type SessionWebSocket, safeSend } from "./ws-handler.ts";

/**
 * Default `maxSteps` for a host agent. Host tasks (e.g. tau2 simulations) may
 * chain several tool calls per turn, so this is more generous than a typical
 * conversational agent.
 */
const DEFAULT_HOST_MAX_STEPS = 30;

/** The inbound `tool_result` payload routed to {@link RelayExecuteTool.onToolResult}. */
export type RelayToolResult = {
  toolCallId: string;
  result: string;
  error?: string | undefined;
};

/** A relay tool executor plus the hooks needed to feed it inbound results. */
export type RelayExecuteTool = {
  /** {@link ExecuteTool} that relays each call to the client and awaits a result. */
  executeTool: ExecuteTool;
  /** Resolve (or reject) the pending call matching `toolCallId`. */
  onToolResult(msg: RelayToolResult): void;
  /** Reject every still-pending call (call on connection close). */
  dispose(): void;
};

type ToolCallEvent = Extract<ClientEvent, { type: "tool_call" }>;

/**
 * A relay's `result` field arrives as a string on the wire. Clients commonly
 * JSON-encode their tool output; unwrap a JSON string so the model receives
 * clean text, but leave object/array JSON (and non-JSON) untouched.
 */
function normalizeResult(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

/**
 * Build a relay tool executor: `executeTool` emits a `tool_call` frame via
 * `send` and returns a promise keyed by `toolCallId`; `onToolResult` settles
 * that promise when the client replies. Calls that never receive a result
 * reject after `timeoutMs` (default {@link DEFAULT_RELAY_TOOL_TIMEOUT_MS}).
 */
export function createRelayExecuteTool(opts: {
  send: (event: ToolCallEvent) => void;
  timeoutMs?: number | undefined;
}): RelayExecuteTool {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELAY_TOOL_TIMEOUT_MS;
  type Pending = {
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    /** Remove the abort listener (no-op when the call carried no signal). */
    unlisten: () => void;
  };
  const pending = new Map<string, Pending>();

  function clear(toolCallId: string): Pending | undefined {
    const entry = pending.get(toolCallId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.unlisten();
    pending.delete(toolCallId);
    return entry;
  }

  const executeTool: ExecuteTool = (name, args, _sessionId, _messages, callOpts) => {
    const toolCallId = callOpts?.toolCallId;
    if (!toolCallId) {
      // Defensive: every path should thread a toolCallId (see session-core /
      // to-vercel-tools). Without one the result can't be correlated.
      return Promise.resolve(toolError(`Relay tool "${name}" invoked without a toolCallId`));
    }
    if (pending.has(toolCallId)) {
      // A second in-flight call with the same id would clobber the first
      // entry, and the first call's timer would then delete the new entry —
      // dropping its genuine tool_result. Refuse instead of clobbering.
      return Promise.resolve(
        toolError(`Relay tool "${name}" duplicates in-flight toolCallId "${toolCallId}"`),
      );
    }
    const signal = callOpts?.signal;
    if (signal?.aborted) {
      return Promise.resolve(toolError(`Relay tool "${name}" (${toolCallId}) was cancelled`));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        clear(toolCallId);
        reject(new Error(`Relay tool "${name}" (${toolCallId}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Never let a pending relay call keep the process alive on its own.
      timer.unref?.();
      const onAbort = () => {
        clear(toolCallId);
        reject(new Error(`Relay tool "${name}" (${toolCallId}) was cancelled`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const unlisten = () => signal?.removeEventListener("abort", onAbort);
      pending.set(toolCallId, { resolve, reject, timer, unlisten });
      opts.send({ type: "tool_call", toolCallId, toolName: name, args });
    });
  };

  function onToolResult(msg: RelayToolResult): void {
    const entry = clear(msg.toolCallId);
    if (!entry) return;
    if (msg.error !== undefined) {
      entry.reject(new Error(msg.error));
      return;
    }
    entry.resolve(normalizeResult(msg.result));
  }

  function dispose(): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.unlisten();
      entry.reject(new Error("Relay disposed before tool result arrived"));
    }
    pending.clear();
  }

  return { executeTool, onToolResult, dispose };
}

/**
 * Whether host mode is permitted for this environment. Defaults to enabled;
 * only an explicit `AAI_ALLOW_HOST` of `0`/`false` (case-insensitive) disables it.
 */
export function isHostAllowed(env: Record<string, string>): boolean {
  const raw = env.AAI_ALLOW_HOST;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return true;
  return normalized !== "0" && normalized !== "false";
}

/**
 * Synthesize an {@link AgentDef} from a host block. Host tools are relayed to
 * the client rather than executed in-process, so the agent carries no real
 * `ToolDef`s — the tool schemas are supplied to the runtime separately via
 * {@link RuntimeOptions.toolSchemas}.
 *
 * When a `baseAgent` (the server's deployed agent) is provided, its provider
 * config (`stt`/`llm`/`tts` and other pipeline settings) is inherited so the
 * host session runs the SAME pipeline the operator configured — only the
 * system prompt, greeting, and tools are overridden by the injected host
 * block. Without a `baseAgent`, no providers are set and the runtime falls
 * back to the default S2S path.
 */
export function buildHostAgent(host: HostConfig, baseAgent?: AgentDef): AgentDef {
  return {
    ...(baseAgent ?? {}),
    name: baseAgent?.name ?? "host",
    systemPrompt: host.systemPrompt,
    greeting: host.greeting ?? "",
    maxSteps: DEFAULT_HOST_MAX_STEPS,
    // Injected tools are relayed to the client, not executed in-process.
    tools: {},
  };
}

/** Options for {@link startHostSession}. */
export type StartHostSessionOptions = {
  env: Record<string, string>;
  startOpts?: SessionStartOptions;
  logger?: Logger;
  /**
   * The server's deployed agent. Its `stt`/`llm`/`tts` provider config is
   * inherited by the host session so it runs the operator's configured
   * pipeline (rather than defaulting to S2S). Only prompt/greeting/tools are
   * overridden by the client's host block.
   */
  baseAgent?: AgentDef;
  /** Handshake grace period (default {@link DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS}). */
  handshakeTimeoutMs?: number;
  /** Per-tool relay timeout (default {@link DEFAULT_RELAY_TOOL_TIMEOUT_MS}). */
  relayTimeoutMs?: number;
  /** Injectable runtime factory (test seam). Defaults to {@link createRuntime}. */
  createRuntime?: (opts: RuntimeOptions) => ReturnType<typeof createRuntime>;
};

function sendEvent(ws: SessionWebSocket, event: ClientEvent, log: Logger): void {
  safeSend(ws, JSON.stringify(event), log);
}

function rejectHandshake(ws: SessionWebSocket, log: Logger, message: string): void {
  log.warn("host-mode handshake rejected", { message });
  sendEvent(ws, { type: "error", code: "protocol", message }, log);
  // Give the frame a tick to flush before closing.
  setTimeout(() => {
    try {
      (ws as unknown as { close?: (code?: number) => void }).close?.(1008);
    } catch {
      // ignore
    }
  }, 0);
}

/**
 * Derive the S2S sample-rate config from a client's requested rates, falling
 * back to the defaults. The single `config` frame carries the client's
 * `sampleRate`/`ttsSampleRate` alongside the `host` block; honoring them keeps
 * the negotiated audio format consistent end-to-end.
 */
function s2sConfigFromHandshake(msg: {
  sampleRate?: number | undefined;
  ttsSampleRate?: number | undefined;
}): S2SConfig {
  return {
    ...DEFAULT_S2S_CONFIG,
    ...(msg.sampleRate !== undefined ? { inputSampleRate: msg.sampleRate } : {}),
    ...(msg.ttsSampleRate !== undefined ? { outputSampleRate: msg.ttsSampleRate } : {}),
  };
}

/**
 * Deferred host-mode session start.
 *
 * Attaches a one-shot listener for the first inbound text frame, validates it
 * as a host `config` handshake, and — when host mode is allowed — builds a
 * fresh single-use runtime whose tools are relayed to the client, then hands
 * the socket off to the normal `wireSessionSocket` flow via
 * `runtime.startSession`. Invalid, disallowed, or missing handshakes reject the
 * connection with a protocol error.
 */
export function startHostSession(ws: SessionWebSocket, opts: StartHostSessionOptions): void {
  const log = opts.logger ?? consoleLogger;
  const makeRuntime = opts.createRuntime ?? createRuntime;
  let settled = false;

  const handshakeTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectHandshake(ws, log, "host-mode: timed out waiting for config frame");
  }, opts.handshakeTimeoutMs ?? DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  ws.addEventListener("message", (event: { data: unknown }) => {
    if (settled) return;
    const { data } = event;
    // The handshake is a JSON text frame; ignore any stray binary audio.
    if (typeof data !== "string") return;

    settled = true;
    clearTimeout(handshakeTimer);

    const parsed = safeJsonParse(data);
    if (parsed === undefined) {
      rejectHandshake(ws, log, "host-mode: first frame was not valid JSON");
      return;
    }

    const result = HostConfigMessageSchema.safeParse(parsed);
    if (!result.success) {
      rejectHandshake(ws, log, "host-mode: first frame was not a valid host config");
      return;
    }

    if (!isHostAllowed(opts.env)) {
      rejectHandshake(ws, log, "host-mode is disabled on this server (AAI_ALLOW_HOST)");
      return;
    }

    const { host } = result.data;
    const relay = createRelayExecuteTool({
      send: (e) => sendEvent(ws, e, log),
      timeoutMs: opts.relayTimeoutMs,
    });

    let runtime: ReturnType<typeof createRuntime>;
    try {
      runtime = makeRuntime({
        agent: buildHostAgent(host, opts.baseAgent),
        env: opts.env,
        executeTool: relay.executeTool,
        toolSchemas: host.tools as ToolSchema[],
        onToolResult: relay.onToolResult,
        s2sConfig: s2sConfigFromHandshake(result.data),
        logger: log,
      });
    } catch (err) {
      relay.dispose();
      rejectHandshake(ws, log, `host-mode: failed to build runtime: ${errorMessage(err)}`);
      return;
    }

    ws.addEventListener("close", () => relay.dispose());

    log.info("host-mode session starting", { tools: host.tools.length });
    runtime.startSession(ws, opts.startOpts);
  });
}
