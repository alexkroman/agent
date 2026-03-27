// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared Zod schemas and types for the host ↔ isolate wire protocol.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the RPC boundary between
 * the managed server (sandbox.ts) and user-deployed agent code
 * (_harness-runtime.ts). Both sides import from here so that any schema
 * change is validated at compile time AND at runtime on both ends.
 *
 * Adding/removing a field? Update the schema here — TypeScript will flag
 * every callsite that needs to change.
 */

import { AgentConfigSchema, ToolSchemaSchema } from "@alexkroman1/aai/internal-types";
import { z } from "zod";

// ─── IsolateConfig (GET /config response) ───────────────────────────────

/** Zod schema for the hooks capability flags. */
export const HooksSchema = z.object({
  onConnect: z.boolean(),
  onDisconnect: z.boolean(),
  onError: z.boolean(),
  onTurn: z.boolean(),
  onStep: z.boolean(),
  maxStepsIsFn: z.boolean(),
  hasMiddleware: z.boolean(),
});

/** Zod schema for agent metadata returned by the isolate on GET /config. */
export const IsolateConfigSchema = AgentConfigSchema.extend({
  toolSchemas: z.array(ToolSchemaSchema),
  hasState: z.boolean(),
  hooks: HooksSchema,
});

/** Response from GET /config — agent metadata extracted by the harness. */
export type IsolateConfig = z.infer<typeof IsolateConfigSchema>;

// ─── ToolCallRequest / Response (POST /tool) ────────────────────────────

/** Zod schema for POST /tool request body. */
export const ToolCallRequestSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  sessionId: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "tool"]),
      content: z.string(),
    }),
  ),
});

/** Request body for POST /tool — derived from {@link ToolCallRequestSchema}. */
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

/** Zod schema for POST /tool response body. */
export const ToolCallResponseSchema = z.object({
  result: z.string(),
  state: z.record(z.string(), z.unknown()),
});

/** Response body for POST /tool — derived from {@link ToolCallResponseSchema}. */
export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;

// ─── HookRequest / Response (POST /hook) ────────────────────────────────

/** Zod schema for POST /hook request body. */
export const HookRequestSchema = z.object({
  hook: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  step: z
    .object({
      stepNumber: z.number().int().nonnegative(),
      toolCalls: z.array(
        z.object({
          toolName: z.string(),
          args: z.record(z.string(), z.unknown()),
        }),
      ),
      text: z.string(),
    })
    .optional(),
  stepNumber: z.number().int().nonnegative().optional(),
});

/** Request body for POST /hook — derived from {@link HookRequestSchema}. */
export type HookRequest = z.infer<typeof HookRequestSchema>;

/** Zod schema for POST /hook response body. */
export const HookResponseSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
});

/** Response body for POST /hook — derived from {@link HookResponseSchema}. */
export type HookResponse = z.infer<typeof HookResponseSchema>;

// ─── TurnConfig (resolveTurnConfig hook result) ─────────────────────────

/** Zod schema for the resolveTurnConfig hook result. */
export const TurnConfigResultSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
  })
  .nullable();

/** Resolved turn config, or null if no overrides. */
export type TurnConfigResult = z.infer<typeof TurnConfigResultSchema>;

// ─── Hook result validation schemas ─────────────────────────────────────

/** Schema for void hook results — must be undefined/null. */
export const VoidHookResultSchema = z.unknown().transform(() => undefined);

/** Schema for beforeTurn hook result — string or undefined. */
export const BeforeTurnResultSchema = z.unknown().pipe(z.string().optional());

/** Schema for filterInput hook result — string or undefined. */
export const FilterInputResultSchema = z.unknown().pipe(z.string().optional());

/** Schema for filterOutput hook result — string or undefined. */
export const FilterOutputResultSchema = z.unknown().pipe(z.string().optional());

/** Schema for interceptToolCall hook result — discriminated union or undefined. */
export const ToolInterceptResultSchema = z
  .union([
    z.object({ type: z.literal("block"), reason: z.string() }),
    z.object({ type: z.literal("result"), result: z.string() }),
    z.object({ type: z.literal("args"), args: z.record(z.string(), z.unknown()) }),
  ])
  .optional();
