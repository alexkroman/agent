// Copyright 2025 the AAI authors. MIT license.
/**
 * Validation schemas and {@link defineAgent} factory.
 *
 * Split from types.ts to keep the type-only module lean. All Zod schemas
 * and the runtime `defineAgent` function live here.
 */

import { z } from "zod";
import {
  type AgentDef,
  type AgentOptions,
  type BuiltinTool,
  DEFAULT_GREETING,
  DEFAULT_INSTRUCTIONS,
  type ToolChoice,
  // biome-ignore lint/suspicious/noImportCycles: types.ts re-exports from define-agent.ts for public API surface
} from "./types.ts";

// ─── Zod schemas ────────────────────────────────────────────────────────────

/** @internal Zod schema for {@link BuiltinTool}. Exported for reuse in internal schemas. */
export const BuiltinToolSchema = z.enum([
  "web_search",
  "visit_webpage",
  "fetch_json",
  "run_code",
  "vector_search",
  "memory",
]);

/** @internal Zod schema for {@link ToolChoice}. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);

const ToolDefSchema = z.object({
  description: z.string().min(1, "Tool description must be non-empty"),
  parameters: z
    .custom<z.ZodType>(
      (val) => val === undefined || val instanceof z.ZodType,
      "Expected a Zod schema",
    )
    .optional(),
  execute: z.function(),
});

// ─── Compile-time drift guards ──────────────────────────────────────────────
// These type aliases catch at compile time if a manually maintained type
// drifts out of sync with its Zod schema counterpart. If they produce `never`,
// the types have diverged and the build will fail at first usage.

/** @internal Fails to compile if BuiltinTool and BuiltinToolSchema diverge. */
type _AssertBuiltinTool =
  BuiltinTool extends z.infer<typeof BuiltinToolSchema>
    ? z.infer<typeof BuiltinToolSchema> extends BuiltinTool
      ? true
      : never
    : never;
const _btCheck: _AssertBuiltinTool = true;
void _btCheck;

/** @internal Fails to compile if ToolChoice and ToolChoiceSchema diverge. */
type _AssertToolChoice =
  ToolChoice extends z.infer<typeof ToolChoiceSchema>
    ? z.infer<typeof ToolChoiceSchema> extends ToolChoice
      ? true
      : never
    : never;
const _tcCheck: _AssertToolChoice = true;
void _tcCheck;

const AgentOptionsSchema = z.object({
  name: z.string().min(1, "Agent name must be non-empty"),
  instructions: z.string().optional(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  maxSteps: z.union([z.number().int().positive(), z.function()]).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  builtinTools: z.array(BuiltinToolSchema).optional(),
  activeTools: z.array(z.string().min(1)).optional(),
  tools: z.record(z.string(), ToolDefSchema).optional(),
  state: z.function().optional(),
  onConnect: z.function().optional(),
  onDisconnect: z.function().optional(),
  onError: z.function().optional(),
  onTurn: z.function().optional(),
  onStep: z.function().optional(),
  onBeforeStep: z.function().optional(),
});

// ─── defineAgent ────────────────────────────────────────────────────────────

/**
 * Create an agent definition from the given options, applying sensible defaults.
 *
 * This is the main entry point for defining a voice agent. The returned
 * `AgentDef` is consumed by the AAI server at deploy time.
 *
 * @param options - Configuration for the agent including name, instructions,
 *   tools, hooks, and other settings.
 * @returns A fully resolved agent definition with all defaults applied.
 *
 * @public
 *
 * @example Basic agent with a custom tool
 * ```ts
 * import { defineAgent } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "greeter",
 *   instructions: "You greet people warmly.",
 *   tools: {
 *     greet: {
 *       description: "Greet a user by name",
 *       parameters: z.object({ name: z.string() }),
 *       execute: ({ name }) => `Hello, ${name}!`,
 *     },
 *   },
 * });
 * ```
 */
export function defineAgent<S>(options: AgentOptions<S>): AgentDef {
  AgentOptionsSchema.parse(options);
  return {
    ...options,
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    greeting: options.greeting ?? DEFAULT_GREETING,
    maxSteps: options.maxSteps ?? 5,
    tools: options.tools ?? {},
  } as AgentDef;
}
