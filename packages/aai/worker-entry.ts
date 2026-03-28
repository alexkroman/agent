// Copyright 2025 the AAI authors. MIT license.
/**
 * Worker entry point — shared tool execution logic.
 */

import pTimeout from "p-timeout";
import type { z } from "zod";
import { EMPTY_PARAMS } from "./_internal-types.ts";
import { errorDetail, errorMessage, toolError } from "./_utils.ts";
import { TOOL_EXECUTION_TIMEOUT_MS } from "./constants.ts";
import type { Kv } from "./kv.ts";
import type { Logger } from "./runtime.ts";

import type { Message, ToolContext, ToolDef } from "./types.ts";

/** Yield to the event loop so pending I/O (e.g. WebSocket frames) can be processed. */
const yieldTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Function signature for executing a tool by name.
 *
 * @param name - The tool name to execute.
 * @param args - Key-value arguments to pass to the tool handler.
 * @param sessionId - Optional session identifier for stateful tools.
 * @param messages - Optional conversation history for context-aware tools.
 * @returns The tool's string result, or an error message string.
 */
export type ExecuteTool = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  sessionId?: string,
  messages?: readonly Message[],
) => Promise<string>;

function buildToolContext(opts: ExecuteToolCallOptions): ToolContext {
  const { env, state, kv, messages, fetch: fetchFn, sessionId } = opts;
  return {
    env: { ...env },
    state: state ?? {},
    get kv(): Kv {
      if (!kv) throw new Error("KV not available");
      return kv;
    },
    messages: messages ?? [],
    fetch: fetchFn ?? globalThis.fetch,
    sessionId: sessionId ?? "",
  };
}

/** Options for {@link executeToolCall}. */
export type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  state?: Record<string, unknown>;
  sessionId?: string | undefined;
  kv?: Kv | undefined;
  messages?: readonly Message[] | undefined;
  logger?: Logger | undefined;
  /** Override fetch implementation for the tool context. */
  fetch?: typeof globalThis.fetch | undefined;
};

/**
 * Execute a tool call with argument validation and error handling.
 *
 * Validates the provided arguments against the tool's Zod parameter schema,
 * constructs a {@link ToolContext}, invokes the tool's `execute` function,
 * and serializes the result to a string. Errors (validation failures,
 * execution throws, timeouts) are caught and returned as JSON strings
 * via {@link toolError} (`'{"error":"<message>"}'`) rather than thrown.
 *
 * @param name - The name of the tool being invoked.
 * @param args - Raw arguments from the LLM to validate and pass to the tool.
 * @param options - Tool definition, environment, and optional context.
 * @returns The tool's result serialized as a string, or an error message.
 */
export async function executeToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { tool } = options;
  const schema = tool.parameters ?? EMPTY_PARAMS;
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? [])
      .map((i: z.ZodIssue) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join(", ");
    return toolError(`Invalid arguments for tool "${name}": ${issues}`);
  }

  try {
    const ctx = buildToolContext(options);
    await yieldTick();
    const result = await pTimeout(Promise.resolve(tool.execute(parsed.data, ctx)), {
      milliseconds: TOOL_EXECUTION_TIMEOUT_MS,
      message: `Tool "${name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`,
    });
    await yieldTick();
    if (result == null) return "null";
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err: unknown) {
    const log = options.logger;
    if (log) {
      log.warn("Tool execution failed", { tool: name, error: errorDetail(err) });
    } else {
      console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
    }
    return toolError(errorMessage(err));
  }
}
