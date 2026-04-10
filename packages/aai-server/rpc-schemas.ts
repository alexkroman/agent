// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ guest RPC boundary.
 *
 * The host (sandbox.ts) validates isolate responses with these schemas.
 * The isolate (harness-runtime.ts) is self-contained and does not
 * import these schemas — it uses inline type definitions instead.
 */

import { ToolSchemaSchema as ToolSchemaSchema_ } from "@alexkroman1/aai-core/manifest";
import { z } from "zod";

// ── Isolate config ────────────────────────────────────────────────────────

export { ToolSchemaSchema } from "@alexkroman1/aai-core/manifest";

export const IsolateConfigSchema = z.object({
  name: z.string(),
  systemPrompt: z.string(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().optional(),
  toolChoice: z.enum(["auto", "required"]).optional(),
  builtinTools: z.array(z.string()).optional(),
  toolSchemas: z.array(ToolSchemaSchema_).default([]),
});

export type IsolateConfig = z.infer<typeof IsolateConfigSchema>;

// ── RPC response schemas ──────────────────────────────────────────────────

export const ToolCallResponseSchema = z.object({
  result: z.string(),
  state: z.record(z.string(), z.unknown()),
});

export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;

// -- IPC message types (host <-> guest over jsonrpc) --------------------

export const BundleMessageSchema = z.object({
  id: z.string(),
  type: z.literal("bundle"),
  code: z.string(),
  env: z.record(z.string(), z.string()),
});

export const BundleResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const KvRequestSchema = z.discriminatedUnion("op", [
  z.object({ id: z.string(), type: z.literal("kv"), op: z.literal("get"), key: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("kv"),
    op: z.literal("set"),
    key: z.string(),
    value: z.unknown(),
    expireIn: z.number().optional(),
  }),
  z.object({ id: z.string(), type: z.literal("kv"), op: z.literal("del"), key: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("kv"),
    op: z.literal("mget"),
    keys: z.array(z.string()),
  }),
]);

export const KvResponseSchema = z.object({
  id: z.string(),
  value: z.unknown().optional(),
  values: z.array(z.unknown()).optional(),
});

export const ShutdownMessageSchema = z.object({
  id: z.string(),
  type: z.literal("shutdown"),
});

export type BundleMessage = z.infer<typeof BundleMessageSchema>;
export type BundleResponse = z.infer<typeof BundleResponseSchema>;
export type KvRequest = z.infer<typeof KvRequestSchema>;
export type KvResponse = z.infer<typeof KvResponseSchema>;
export type ShutdownMessage = z.infer<typeof ShutdownMessageSchema>;

// ── RPC request types (no Zod — host trusts its own requests) ─────────────

export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: { role: "user" | "assistant" | "tool"; content: string }[];
};
