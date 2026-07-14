// Copyright 2025 the AAI authors. MIT license.
/**
 * Public type declarations for the agent runtime.
 *
 * Split out of `runtime.ts` to keep that module focused on the
 * `createRuntime` implementation. All imports here are type-only.
 */

import type { LanguageModel } from "ai";
import type { ToolSchema } from "../sdk/_internal-types.ts";
import type { Kv } from "../sdk/kv.ts";
import type { ClientSink, ReadyConfig } from "../sdk/protocol.ts";
import type {
  LlmProvider,
  SttOpener,
  SttProvider,
  TtsOpener,
  TtsProvider,
} from "../sdk/providers.ts";
import type { AgentDef, ToolDef } from "../sdk/types.ts";
import type { Vector } from "../sdk/vector.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { SessionCore } from "./session-core.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import type { CreateOpenaiRealtimeWebSocket } from "./transports/openai-realtime-transport.ts";
import type { SessionWebSocket } from "./ws-handler.ts";

/** Per-session options passed to {@link AgentRuntime.startSession}. */
export type SessionStartOptions = {
  skipGreeting?: boolean;
  resumeFrom?: string;
  logContext?: Record<string, string>;
  onOpen?: () => void;
  onClose?: () => void;
  /** Called with session ID after session cleanup, for guest state cleanup. */
  onSessionEnd?: (sessionId: string) => void;
  /** Called with session ID and client sink after session setup. Used by sandbox to route custom events. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
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
};

/**
 * Configuration for {@link createRuntime}.
 *
 * Configures the agent, environment, KV store, logging, and S2S connection.
 *
 * @public
 */
export type RuntimeOptions = {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  env: Record<string, string>;
  kv?: Kv | undefined;
  /**
   * Vector store. If omitted, an in-memory store is created. The
   * runtime overrides this with `agent.vector` if set.
   */
  vector?: Vector | undefined;
  /** Custom WebSocket factory for the S2S connection (useful for testing). */
  createWebSocket?: CreateS2sWebSocket | undefined;
  /** Custom WebSocket factory for the OpenAI Realtime connection (testing). */
  createOpenaiRealtimeWebSocket?: CreateOpenaiRealtimeWebSocket | undefined;
  logger?: Logger | undefined;
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
   */
  executeTool?: ExecuteTool | undefined;
  /**
   * Override tool schemas sent to the S2S API. Required when `executeTool`
   * is provided (the host doesn't have the tool definitions to derive schemas).
   */
  toolSchemas?: ToolSchema[] | undefined;
  /** System prompt guidance for builtin tools. Passed through in sandbox mode. */
  toolGuidance?: string[] | undefined;
  /**
   * Pre-resolved builtin tool definitions. When provided alongside `executeTool`
   * and `toolSchemas`, skips calling `resolveAllBuiltins` on the host.
   */
  builtinDefs?: Record<string, ToolDef> | undefined;
  /**
   * Override the fetch implementation used by built-in tools (web_search,
   * visit_webpage, fetch_json). Defaults to `globalThis.fetch`.
   *
   * In platform mode, pass an SSRF-safe fetch to prevent requests to
   * private/internal networks. In self-hosted mode, users may provide
   * their own fetch wrapper.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * STT provider. Accepts either a descriptor ({@link SttProvider},
   * the normal production path) or a pre-resolved {@link SttOpener}
   * (test escape hatch). Must be set together with `llm` and `tts` to
   * route sessions through the pipeline path; leave all three unset for
   * the default AssemblyAI Streaming Speech-to-Speech (S2S) path.
   */
  stt?: SttProvider | SttOpener | undefined;
  /**
   * LLM provider. Accepts either a descriptor ({@link LlmProvider},
   * produced by factories like `anthropic(...)`) or a concrete Vercel AI
   * SDK `LanguageModel` (self-hosted / test escape hatch).
   */
  llm?: LlmProvider | LanguageModel | undefined;
  /**
   * TTS provider. Accepts either a descriptor ({@link TtsProvider})
   * or a pre-resolved {@link TtsOpener}.
   */
  tts?: TtsProvider | TtsOpener | undefined;
};

/**
 * The agent runtime returned by {@link createRuntime}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code, and also exposes
 * lower-level helpers (`executeTool`, `hooks`, `toolSchemas`,
 * `createSession`) for testing and advanced usage.
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
