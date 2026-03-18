// Copyright 2025 the AAI authors. MIT license.
/**
 * Worker entry point — shared tool execution logic.
 *
 * @module
 */

import { z } from "zod";
import type { Kv } from "./kv.ts";
import type { Message, ToolContext, ToolDef } from "./types.ts";
import type { VectorStore } from "./vector.ts";

/**
 * Maximum time in milliseconds a tool handler may run before being aborted.
 *
 * If a tool's `execute` function exceeds this duration, it is cancelled via
 * `AbortSignal.timeout` and an error message is returned to the LLM.
 */
export const TOOL_HANDLER_TIMEOUT = 30_000;

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

/** Options for {@linkcode executeToolCall}. */
export type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  sessionId?: string | undefined;
  state?: Record<string, unknown>;
  kv?: Kv | undefined;
  vector?: VectorStore | undefined;
  messages?: readonly Message[] | undefined;
};

/**
 * Execute a tool call with argument validation, timeout, and error handling.
 *
 * Validates the provided arguments against the tool's Zod parameter schema,
 * constructs a {@linkcode ToolContext}, invokes the tool's `execute` function,
 * and serializes the result to a string. Errors and timeouts are caught and
 * returned as `"Error: ..."` strings rather than thrown.
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
  const { tool, env, sessionId, state, kv, vector, messages } = options;
  const schema = tool.parameters ?? z.object({});
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? [])
      .map((i: z.ZodIssue) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join(", ");
    return `Error: Invalid arguments for tool "${name}": ${issues}`;
  }

  try {
    const abortSignal = AbortSignal.timeout(TOOL_HANDLER_TIMEOUT);
    const envCopy = { ...env };
    const ctx: ToolContext = {
      sessionId: sessionId ?? "",
      env: envCopy,
      abortSignal,
      state: state ?? {},
      get kv(): Kv {
        if (!kv) throw new Error("KV not available");
        return kv;
      },
      get vector(): VectorStore {
        if (!vector) throw new Error("Vector store not available");
        return vector;
      },
      messages: messages ?? [],
    };
    const result = await Promise.resolve(tool.execute(parsed.data, ctx));
    if (result == null) return "null";
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      console.warn(`[tool-executor] Tool execution timed out: ${name}`);
      return `Error: Tool "${name}" timed out after ${TOOL_HANDLER_TIMEOUT}ms`;
    }
    console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
