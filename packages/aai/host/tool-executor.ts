// Copyright 2025 the AAI authors. MIT license.
/**
 * Tool execution — validates arguments and invokes tool handlers.
 *
 * {@link executeToolCall} is the single entry point used by both the
 * direct (self-hosted) runtime and the platform sandbox sidecar.
 */

import pTimeout from "p-timeout";
import type { z } from "zod";
import { EMPTY_PARAMS } from "../sdk/_internal-types.ts";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { Message, ToolContext, ToolDef } from "../sdk/types.ts";
import { errorDetail, errorMessage, toolError } from "../sdk/utils.ts";
import type { Vector } from "../sdk/vector.ts";
import type { Logger } from "./runtime-config.ts";

export type { ExecuteTool } from "../sdk/_internal-types.ts";

const yieldTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  state?: Record<string, unknown>;
  sessionId?: string | undefined;
  kv?: Kv | undefined;
  vector?: Vector | undefined;
  messages?: readonly Message[] | undefined;
  logger?: Logger | undefined;
  send?: ((event: string, data: unknown) => void) | undefined;
};

function buildToolContext(opts: ExecuteToolCallOptions): ToolContext {
  const { env, state, kv, vector, messages, sessionId, send } = opts;
  return {
    env,
    state: state ?? {},
    get kv(): Kv {
      if (!kv) throw new Error("KV not available");
      return kv;
    },
    get vector(): Vector {
      if (!vector) throw new Error("Vector not available");
      return vector;
    },
    messages: messages ?? [],
    sessionId: sessionId ?? "",
    send(event: string, data: unknown): void {
      send?.(event, data);
    },
  };
}

function formatZodIssues(error: z.ZodError | undefined): string {
  return (error?.issues ?? [])
    .map((i: z.ZodIssue) => `${i.path.map(String).join(".")}: ${i.message}`)
    .join(", ");
}

function stringifyResult(result: unknown): string {
  if (result == null) return "null";
  return typeof result === "string" ? result : JSON.stringify(result);
}

export async function executeToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { tool, logger } = options;
  const schema = tool.parameters ?? EMPTY_PARAMS;
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return toolError(`Invalid arguments for tool "${name}": ${formatZodIssues(parsed.error)}`);
  }

  try {
    const ctx = buildToolContext(options);
    await yieldTick();
    const result = await pTimeout(Promise.resolve(tool.execute(parsed.data, ctx)), {
      milliseconds: TOOL_EXECUTION_TIMEOUT_MS,
      message: `Tool "${name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`,
    });
    await yieldTick();
    return stringifyResult(result);
  } catch (err: unknown) {
    if (logger) {
      logger.warn("Tool execution failed", { tool: name, error: errorDetail(err) });
    } else {
      console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
    }
    return toolError(errorMessage(err));
  }
}
