// Copyright 2025 the AAI authors. MIT license.
/**
 * KV-backed memory tools for agent persistent state.
 */

import { z } from "zod";
import { defineTool } from "./types.ts";

/**
 * Returns a standard set of KV-backed memory tools: `save_memory`,
 * `recall_memory`, `list_memories`, and `forget_memory`.
 *
 * Spread the result into your agent's `tools` record.
 *
 * @example
 * ```ts
 * import { defineAgent, memoryTools } from "aai";
 *
 * export default defineAgent({
 *   name: "My Agent",
 *   tools: { ...memoryTools() },
 * });
 * ```
 *
 * @returns A record with four tool definitions: `save_memory`, `recall_memory`,
 *   `list_memories`, and `forget_memory`.
 * @public
 */
export function memoryTools() {
  return {
    save_memory: defineTool({
      description:
        "Save a piece of information to persistent memory. Use a descriptive key like 'user:name' or 'project:status'.",
      parameters: z.object({
        key: z
          .string()
          .describe("A descriptive key for this memory (e.g. 'user:name', 'preference:color')"),
        value: z.string().describe("The information to remember"),
      }),
      execute: async ({ key, value }, ctx) => {
        await ctx.kv.set(key, value);
        return { saved: key };
      },
    }),
    recall_memory: defineTool({
      description: "Retrieve a previously saved memory by its key.",
      parameters: z.object({
        key: z.string().describe("The key to look up"),
      }),
      execute: async ({ key }, ctx) => {
        const value = await ctx.kv.get(key);
        if (value === null) return { found: false, key };
        return { found: true, key, value };
      },
    }),
    list_memories: defineTool({
      description: "List all saved memory keys, optionally filtered by a prefix (e.g. 'user:').",
      parameters: z.object({
        prefix: z
          .string()
          .describe("Prefix to filter keys (e.g. 'user:'). Use empty string for all.")
          .optional(),
      }),
      execute: async ({ prefix }, ctx) => {
        const entries = await ctx.kv.list(prefix ?? "");
        return { count: entries.length, keys: entries.map((e) => e.key) };
      },
    }),
    forget_memory: defineTool({
      description: "Delete a previously saved memory by its key.",
      parameters: z.object({
        key: z.string().describe("The key to delete"),
      }),
      execute: async ({ key }, ctx) => {
        await ctx.kv.delete(key);
        return { deleted: key };
      },
    }),
  };
}
