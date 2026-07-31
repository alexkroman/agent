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

import pTimeout from "p-timeout";
import type { ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import {
  DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_RELAY_TOOL_TIMEOUT_MS,
} from "../sdk/constants.ts";
import type { ClientEvent, HostConfig } from "../sdk/protocol.ts";
import { HostConfigMessageSchema } from "../sdk/protocol.ts";
import type { AgentDef } from "../sdk/types.ts";
import { errorMessage, safeJsonParse, toolError } from "../sdk/utils.ts";
import { UNPACED_AUDIO_LEAD_MS } from "./audio-pacer.ts";
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
  };
  const pending = new Map<string, Pending>();

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
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    pending.set(toolCallId, { resolve, reject });
    opts.send({ type: "tool_call", toolCallId, toolName: name, args });
    // p-timeout owns the deadline and the abort listener: it rejects with the
    // timeout Error below, or with the signal's abort reason on cancellation.
    // Either way the pending entry is dropped once the call settles.
    return pTimeout(promise, {
      milliseconds: timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
      message: new Error(`Relay tool "${name}" (${toolCallId}) timed out after ${timeoutMs}ms`),
    }).finally(() => {
      pending.delete(toolCallId);
    });
  };

  function onToolResult(msg: RelayToolResult): void {
    const entry = pending.get(msg.toolCallId);
    if (!entry) return;
    pending.delete(msg.toolCallId);
    if (msg.error !== undefined) {
      entry.reject(new Error(msg.error));
      return;
    }
    entry.resolve(normalizeResult(msg.result));
  }

  function dispose(): void {
    for (const [, entry] of pending) {
      entry.reject(new Error("Relay disposed before tool result arrived"));
    }
    pending.clear();
  }

  return { executeTool, onToolResult, dispose };
}

/**
 * Whether host mode is permitted for this environment.
 *
 * Opt-in: host mode is enabled only by an explicit `AAI_ALLOW_HOST` of
 * `1`/`true`/`yes`/`on` (case-insensitive). Anything else — including the
 * variable being unset — disables it.
 *
 * This used to default to enabled, which was fail-open for a feature that
 * lets an unauthenticated client replace the agent definition: a `?host=1`
 * connection supplies its own `systemPrompt`, `greeting`, and relayed tool
 * schemas, and the resulting session runs on the operator's provider
 * credentials. Since the self-hosted server has no request authentication of
 * its own, anyone who could reach the port could drive an arbitrary agent on
 * the operator's keys. Harnesses that need host mode (e.g. tau2) now set the
 * variable explicitly.
 */
export function isHostAllowed(env: Record<string, string>): boolean {
  const normalized = env.AAI_ALLOW_HOST?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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
    // STT biasing follows the provider triple's inheritance rule: the client's
    // value wins when sent, the operator's configured prompt stands otherwise.
    ...(host.sttPrompt !== undefined ? { sttPrompt: host.sttPrompt } : {}),
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
  /**
   * Whether this connection may use host mode, overriding the `AAI_ALLOW_HOST`
   * env gate.
   *
   * The self-hosted dev server leaves this unset: it is single-user and
   * loopback-bound, so an operator env flag is the right control. The
   * multi-tenant platform passes `true` only after verifying the caller owns
   * the slug — there, an env flag would be all-or-nothing across tenants, and
   * host mode spends the *owner's* provider credentials.
   */
  allowHost?: boolean | undefined;
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

    if (!(opts.allowHost ?? isHostAllowed(opts.env))) {
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
    // A host-mode client is programmatic by construction — it supplies the
    // agent definition and executes the tools, and browsers cannot even open
    // one (the platform requires an `Authorization` header on the upgrade). It
    // therefore owns its own playback clock, so relaying audio at the wall
    // clock's pace only starves it: a harness whose timeline advances per
    // processed tick sees the agent trail off mid-sentence and answers as if
    // the line went quiet. Overridable — a caller that really does play in real
    // time can set its own lead.
    runtime.startSession(ws, {
      audioLeadMs: UNPACED_AUDIO_LEAD_MS,
      ...opts.startOpts,
    });
  });
}
