// Copyright 2025 the AAI authors. MIT license.
/**
 * Public type declarations for the agent runtime.
 *
 * Split out of `runtime.ts` to keep that module focused on the
 * `createRuntime` implementation. All imports here are type-only.
 */

import type { ToolSchema } from "../sdk/_internal-types.ts";
import type { Db } from "../sdk/db.ts";
import type { AgentEnv, ProviderEnv } from "../sdk/env-types.ts";
import type { ClientSink, ReadyConfig } from "../sdk/protocol.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../sdk/providers.ts";
import type { AgentDef } from "../sdk/types.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { SessionCore } from "./session-core.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import type { CreateOpenaiRealtimeWebSocket } from "./transports/openai-realtime-transport.ts";
import type { WorkflowApiEngine } from "./workflow-api.ts";
import type { SessionWebSocket } from "./ws-handler.ts";

/** Per-session options passed to {@link AgentRuntime.startSession}. */
export type SessionStartOptions = {
  skipGreeting?: boolean;
  resumeFrom?: string;
  logContext?: Record<string, string>;
  onOpen?: () => void;
  onClose?: () => void;
  /**
   * Called with session ID after session cleanup, for guest state cleanup.
   * `sink` is the ending connection's own client sink; compare it against the
   * sink the latest `onSinkCreated` delivered before releasing per-session
   * state — a resume can register a NEW session under the same id while the
   * old one drains, and a bare keyed cleanup here would tear down the live
   * resumed session's state.
   */
  onSessionEnd?: (sessionId: string, sink?: ClientSink) => void;
  /** Called with session ID and client sink after session setup. Used by sandbox to route custom events. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
  /**
   * Audio pacing lead for this session, in ms. The default suits a client that
   * plays audio in real time (a browser); pass `UNPACED_AUDIO_LEAD_MS` for a
   * programmatic client that buffers and meters playback itself.
   */
  audioLeadMs?: number;
};

/**
 * Common interface for agent runtimes.
 *
 * Implemented by {@link createRuntime} and the platform sandbox.
 */
export type AgentRuntime = {
  startSession(ws: SessionWebSocket, opts?: SessionStartOptions): void;
  shutdown(): Promise<void>;
  readonly readyConfig: ReadyConfig;
  /**
   * The agent's workflow engine, or undefined when it declared no workflows
   * (or storage is off, so runs could not be journaled).
   *
   * Exposed because the workflow HTTP API is served by `createServer`, which
   * sees only {@link SessionRuntime} and so cannot reach inside the runtime for
   * it. It is also what a guest harness forwards across the harness↔bundle
   * contract, which is why it is optional there too — a bundle built with an
   * older SDK simply has none, and the API answers 404.
   */
  readonly workflows?: WorkflowApiEngine | undefined;
};

/**
 * Configuration for {@link createRuntime}.
 *
 * Configures the agent, environment, database, logging, and S2S connection.
 *
 * @public
 */
export type RuntimeOptions = {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  /**
   * The agent's own env — what tool code sees as `ctx.env`. Typed
   * `AgentEnv`: a `withHostCredentialFallback` result (which may carry
   * host/shell credentials) is a compile error here — pass it as
   * {@link RuntimeOptions.providerEnv} instead.
   */
  env: AgentEnv;
  /**
   * Environment used to resolve provider credentials (STT/TTS/LLM).
   * Defaults to {@link RuntimeOptions.env}.
   *
   * Exists so a self-hosted caller can let shell-exported credentials reach
   * the provider resolvers without also placing them in `ctx.env`, where agent
   * tool code could read them and come to depend on host-level variables that
   * do not exist in production. The platform passes neither — it resolves
   * everything from the agent's own stored env.
   */
  providerEnv?: ProviderEnv | undefined;
  /**
   * SQL database exposed to tool code as `ctx.db`. When omitted, the runtime
   * connects one itself from `DATABASE_URL` in the provider env (self-hosted
   * `aai dev` parity with the platform's database switch); with neither,
   * `ctx.db` access throws.
   */
  db?: Db | undefined;
  /**
   * Custom WebSocket factory for the S2S connection (testing seam).
   * @internal
   */
  createWebSocket?: CreateS2sWebSocket | undefined;
  /**
   * Custom WebSocket factory for the OpenAI Realtime connection (testing seam).
   * @internal
   */
  createOpenaiRealtimeWebSocket?: CreateOpenaiRealtimeWebSocket | undefined;
  /** Structured logger for runtime and session logs. Defaults to the console. */
  logger?: Logger | undefined;
  /** S2S endpoint URL and audio sample rates. Defaults to `DEFAULT_S2S_CONFIG`. */
  s2sConfig?: S2SConfig | undefined;
  /**
   * Timeout in ms for `session.start()` (S2S connection setup).
   * Defaults to 10 000 (10 s).
   */
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Maximum time in milliseconds to wait for sessions to stop during
   * {@link AgentRuntime.shutdown | shutdown()}. Defaults to `30_000` (30 s).
   */
  shutdownTimeoutMs?: number | undefined;
  /**
   * Override tool execution. When provided, `createRuntime` skips building
   * in-process tool definitions and uses this function instead. Used by the
   * platform sandbox to RPC tool calls to the isolate.
   *
   * @internal
   */
  executeTool?: ExecuteTool | undefined;
  /**
   * Override tool schemas sent to the S2S API. Required when `executeTool`
   * is provided (the host doesn't have the tool definitions to derive schemas).
   *
   * @internal
   */
  toolSchemas?: ToolSchema[] | undefined;
  /**
   * Host/relay mode hook. When set, inbound `tool_result` frames are routed to
   * this handler (which settles the relay's pending call) and the session skips
   * its own `tool_call` emit since the relay `executeTool` emits it. Paired with
   * a relay `executeTool` + `toolSchemas`. See host-mode.ts.
   */
  onToolResult?:
    | ((msg: { toolCallId: string; result: string; error?: string }) => void)
    | undefined;
  /** System prompt guidance for builtin tools. Passed through in sandbox mode. */
  toolGuidance?: string[] | undefined;
  /**
   * Override the fetch implementation used by built-in tools (web_search,
   * visit_webpage, get_page_design, fetch_json). Defaults to `builtinFetch()`:
   * SSRF-screened unless the spawner declared a real container around the
   * process (`AAI_SANDBOX_CONTAINED=1`), in which case the sandbox is the
   * boundary and the screen is skipped. Override only in tests.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * In-sandbox executor for the `run_code` builtin. Only the platform's
   * guest harness provides one — it runs inside the Modal sandbox, which is
   * the security boundary. Without it, run_code refuses to evaluate code in
   * this process (the self-hosted guard).
   */
  runCode?: ((code: string) => Promise<string | { error: string }>) | undefined;
  /**
   * STT provider descriptor ({@link SttProvider}). Must be set together with
   * `llm` and `tts` to route sessions through the pipeline path; leave all
   * three unset to fall back to the agent's own provider fields (which
   * default to the all-AssemblyAI pipeline when the agent declares none).
   */
  stt?: SttProvider | undefined;
  /** LLM provider descriptor, from a factory like `anthropic(...)`. */
  llm?: LlmProvider | undefined;
  /** TTS provider descriptor ({@link TtsProvider}). */
  tts?: TtsProvider | undefined;
};

/**
 * The agent runtime returned by {@link createRuntime}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code, and also exposes
 * lower-level helpers (`executeTool`, `toolSchemas`, `createSession`) for
 * testing and advanced usage.
 *
 * @public
 */
export type Runtime = AgentRuntime & {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Tool schemas registered with the S2S API (custom + built-in). */
  toolSchemas: ToolSchema[];
  /** Create a new voice session for a connected client (lower-level than startSession). */
  createSession(opts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  }): SessionCore;
};
