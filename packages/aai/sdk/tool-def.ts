// Copyright 2026 the AAI authors. MIT license.
/**
 * What a TOOL is, as a type: its definition and the two helpers that read one.
 *
 * Split out of `types.ts` for the same reason `agent-defaults.ts` and
 * `tool-context.ts` were — that file is at the 500-line cap — and along the
 * seam an author already reads as one unit: a tool's shape, its input type and
 * its result type. Import them from `./types.ts` (which re-exports all three) or
 * from the package root, as before.
 *
 * `DefaultToolResult` deliberately stayed behind: `biome.json` turns
 * `noExplicitAny` off for `types.ts` by path, and moving the one `any` here
 * would need a second override or an escape hatch on the ratchet.
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext } from "./tool-context.ts";

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), an optional input schema, and an
 * `execute` function that runs inside the sandboxed worker.
 *
 * @typeParam P - The tool's input schema: any
 *   [Standard Schema](https://standardschema.dev) that can convert to JSON
 *   Schema — a Zod object schema (the documented default) or e.g. an
 *   ArkType type. Defaults to a permissive record schema so tools without
 *   inputs don't need an explicit type argument.
 *
 * @typeParam R - What `execute` returns, inferred at the {@link tool} call and
 *   read by {@link InferToolOutput}. Defaults to `unknown`, so `ToolDef<typeof
 *   schema>` still means "any result".
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const weatherTool = tool({
 *   description: "Get current weather for a city",
 *   inputSchema: z.object({
 *     city: z.string().describe("City name"),
 *   }),
 *   execute: async ({ city }) => {
 *     const res = await fetch(`https://wttr.in/${city}?format=j1`);
 *     return await res.json();
 *   },
 * });
 * ```
 *
 * @public
 */
export type ToolDef<P extends ToolInputSchema = ToolInputSchema, R = unknown> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /**
   * Schema for the tool's input, shown to the LLM and used to validate each
   * call's arguments before `execute` runs. Named after the Vercel AI SDK's
   * `tool({ inputSchema })`.
   */
  inputSchema?: P;
  /**
   * Function that executes the tool and returns a result. The result is
   * JSON-serialized for the LLM and the client, and capped at
   * `MAX_TOOL_RESULT_CHARS` (4000) characters — longer results are
   * trimmed and end with a `[truncated]` marker.
   */
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): R;
};

/**
 * The validated input type a tool's `execute` receives — inferred from the
 * tool's `inputSchema`. The Vercel AI SDK's `InferToolInput` pattern, so a
 * client (or another tool) can share the exact argument shape without
 * re-declaring it.
 *
 * ```ts
 * import { type InferToolInput, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const add = tool({
 *   description: "Add an item",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }) => item,
 * });
 * type AddInput = InferToolInput<typeof add>; // { item: string }
 * ```
 *
 * @public
 */
export type InferToolInput<T extends ToolDef<ToolInputSchema>> = Parameters<T["execute"]>[0];

/**
 * The result type a tool's `execute` returns (awaited, so a sync and an `async`
 * body infer alike). Pair with `useToolResult<InferToolOutput<typeof myTool>>(...)`
 * in a custom client so the rendered shape has a single source of truth.
 *
 * @public
 */
export type InferToolOutput<T extends ToolDef<ToolInputSchema>> = Awaited<ReturnType<T["execute"]>>;
