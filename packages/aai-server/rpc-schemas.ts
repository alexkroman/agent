// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ isolate RPC boundary.
 *
 * The host (sandbox.ts) validates isolate responses with these schemas.
 * The isolate (harness-runtime.ts) uses `import type` to share the
 * inferred types — type-only imports are erased at compile time, so
 * the isolate never depends on Zod at runtime.
 */

import { z } from "zod";

// ── Isolate config ────────────────────────────────────────────────────────

export const HooksSchema = z.object({
  onConnect: z.boolean(),
  onDisconnect: z.boolean(),
  onError: z.boolean(),
  onUserTranscript: z.boolean(),
  maxStepsIsFn: z.boolean(),
});

export const ToolSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

export const IsolateConfigSchema = z.object({
  name: z.string(),
  systemPrompt: z.string(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().optional(),
  toolChoice: z.enum(["auto", "required"]).optional(),
  builtinTools: z.array(z.string()).optional(),
  toolSchemas: z.array(ToolSchemaSchema),
  hasState: z.boolean(),
  hooks: HooksSchema,
});

export type IsolateConfig = z.infer<typeof IsolateConfigSchema>;

// ── RPC response schemas ──────────────────────────────────────────────────

export const ToolCallResponseSchema = z.object({
  result: z.string(),
  state: z.record(z.string(), z.unknown()),
});

export const HookResponseSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
});

export const TurnConfigResultSchema = z
  .object({ maxSteps: z.number().int().positive().optional() })
  .nullable();

export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;
export type HookResponse = z.infer<typeof HookResponseSchema>;
export type TurnConfigResult = z.infer<typeof TurnConfigResultSchema>;

// ── RPC request types (no Zod — host trusts its own requests) ─────────────

export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: { role: "user" | "assistant" | "tool"; content: string }[];
};

export type HookRequest = {
  hook: string;
  sessionId: string;
  text?: string;
  error?: { message: string };
};
