// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared types for the host ↔ isolate wire protocol.
 *
 * These types are used by both sandbox.ts (host side) and
 * _harness-runtime.ts (isolate side) to ensure the JSON shapes match
 * at compile time.
 */

import type { AgentConfig, ToolSchema } from "@alexkroman1/aai/internal-types";
import type { Message, StepInfo } from "@alexkroman1/aai/types";

/** Response from GET /config — agent metadata extracted by the harness. */
export type IsolateConfig = AgentConfig & {
  toolSchemas: ToolSchema[];
  hasState: boolean;
  hooks: {
    onConnect: boolean;
    onDisconnect: boolean;
    onError: boolean;
    onTurn: boolean;
    onStep: boolean;
    onBeforeStep: boolean;
    maxStepsIsFn: boolean;
  };
};

/** Request body for POST /tool */
export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: readonly Message[];
  env: Record<string, string>;
};

/** Response body for POST /tool */
export type ToolCallResponse = {
  result: string;
  state: Record<string, unknown>;
};

/** Request body for POST /hook */
export type HookRequest = {
  hook: string;
  sessionId: string;
  env: Record<string, string>;
  text?: string;
  error?: { message: string };
  step?: StepInfo;
  stepNumber?: number;
};

/** Response body for POST /hook */
export type HookResponse = {
  state: Record<string, unknown>;
  result?: unknown;
};
