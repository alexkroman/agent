// Copyright 2025 the AAI authors. MIT license.
/**
 * Worker entry point — shared tool execution logic.
 */

import type { z } from "zod";
import { EMPTY_PARAMS } from "./_internal-types.ts";
import { errorDetail, errorMessage } from "./_utils.ts";
import type { Kv } from "./kv.ts";
import { TOOL_EXECUTION_TIMEOUT_MS } from "./protocol.ts";
import type { Logger } from "./runtime.ts";

import type { Message, ToolContext, ToolDef } from "./types.ts";
import type { VectorStore } from "./vector.ts";

/**
 * Normalize enum arguments to handle case mismatches from voice/STT input.
 *
 * When users speak enum values, STT may produce "Study" instead of "study".
 * This function inspects the Zod schema for enum fields and performs
 * case-insensitive matching, returning a corrected copy of the args.
 */
function normalizeEnumArgs(
  args: Readonly<Record<string, unknown>>,
  schema: z.ZodType,
): Record<string, unknown> {
  // Only handle ZodObject schemas (the common case for tool parameters)
  const def = (schema as { _zod?: { def?: { type?: string; shape?: Record<string, z.ZodType> } } })
    ._zod?.def;
  if (!def || def.type !== "object" || !def.shape) return { ...args };

  const result: Record<string, unknown> = { ...args };
  for (const [key, fieldSchema] of Object.entries(def.shape)) {
    const fieldDef = (
      fieldSchema as { _zod?: { def?: { type?: string; entries?: Record<string, unknown> } } }
    )._zod?.def;
    if (fieldDef?.type !== "enum" || !fieldDef.entries || typeof result[key] !== "string") {
      continue;
    }
    const input = result[key] as string;
    // entries is an object like { study: "study", garden: "garden" }
    const values = Object.values(fieldDef.entries) as string[];
    // If it already matches exactly, skip
    if (values.includes(input)) continue;
    const lower = input.toLowerCase();
    const match = values.find((v) => typeof v === "string" && v.toLowerCase() === lower);
    if (match) result[key] = match;
  }
  return result;
}

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
  const { env, state, kv, vector, messages } = opts;
  return {
    env: { ...env },
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
}

/** Options for {@link executeToolCall}. */
export type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  state?: Record<string, unknown>;
  kv?: Kv | undefined;
  vector?: VectorStore | undefined;
  messages?: readonly Message[] | undefined;
  logger?: Logger | undefined;
};

/**
 * Execute a tool call with argument validation and error handling.
 *
 * Validates the provided arguments against the tool's Zod parameter schema,
 * constructs a {@link ToolContext}, invokes the tool's `execute` function,
 * and serializes the result to a string. Errors are caught and returned as
 * `"Error: ..."` strings rather than thrown.
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
  const normalized = normalizeEnumArgs(args, schema);
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? [])
      .map((i: z.ZodIssue) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join(", ");
    return `Error: Invalid arguments for tool "${name}": ${issues}`;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctx = buildToolContext(options);
    await yieldTick();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Tool "${name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)),
        TOOL_EXECUTION_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([Promise.resolve(tool.execute(parsed.data, ctx)), timeout]);
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
    return `Error: ${errorMessage(err)}`;
  } finally {
    clearTimeout(timer);
  }
}
