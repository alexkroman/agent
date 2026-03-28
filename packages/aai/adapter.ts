// Copyright 2025 the AAI authors. MIT license.
/**
 * Runtime adapter interface — the contract between shared session logic
 * and runtime-specific implementations (self-hosted, platform, edge, etc.).
 *
 * Both `createDirectExecutor` (self-hosted) and `createSandbox` (platform)
 * satisfy this interface, making server code runtime-agnostic.
 */

import type { ReadyConfig } from "./protocol.ts";
import type { SessionWebSocket } from "./ws-handler.ts";

/**
 * Per-session options passed to {@link AgentRuntime.startSession}.
 */
export type SessionStartOptions = {
  /** Skip the agent greeting on connect (e.g. when resuming). */
  skipGreeting?: boolean;
  /** Old session ID to resume from (loads persisted state from KV). */
  resumeFrom?: string;
  /** Additional key-value pairs included in log messages. */
  logContext?: Record<string, string>;
  /** Callback invoked when the WebSocket connection opens. */
  onOpen?: () => void;
  /** Callback invoked when the WebSocket connection closes. */
  onClose?: () => void;
};

/**
 * Common interface for agent runtimes.
 *
 * Implemented by the self-hosted direct executor and the platform sandbox.
 * Server/transport code depends only on this interface, making it easy to
 * swap runtimes or add new ones (edge, Deno, test harness, etc.).
 */
export type AgentRuntime = {
  /** Wire a WebSocket to a new voice session. */
  startSession(ws: SessionWebSocket, opts?: SessionStartOptions): void;
  /** Gracefully stop all sessions and release resources. */
  shutdown(): Promise<void>;
  /** Protocol config sent to clients on connect. */
  readonly readyConfig: ReadyConfig;
};
