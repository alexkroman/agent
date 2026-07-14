// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ guest RPC boundary.
 *
 * The isolate (harness-runtime.ts) is self-contained and uses inline type
 * definitions instead of importing these schemas, so host and guest can
 * evolve independently.
 */

import { DEFAULT_SYSTEM_PROMPT, errorMessage } from "@alexkroman1/aai";
import {
  assertProviderTriple,
  ProviderDescriptorSchema,
  ToolSchemaSchema,
} from "@alexkroman1/aai/manifest";
import { KvDelSchema, KvGetSchema, KvSetSchema } from "@alexkroman1/aai/protocol";
import { z } from "zod";

export { ToolSchemaSchema } from "@alexkroman1/aai/manifest";

/**
 * Validated independently from `AgentConfig` (sdk/_internal-types.ts) so the
 * host↔guest wire format can evolve separately from the in-process type.
 */
export const IsolateConfigSchema = z
  .object({
    name: z.string(),
    systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
    greeting: z.string().optional(),
    sttPrompt: z.string().optional(),
    maxSteps: z.number().optional(),
    toolChoice: z.enum(["auto", "required"]).optional(),
    builtinTools: z.array(z.string()).optional(),
    toolSchemas: z.array(ToolSchemaSchema).default([]),
    allowedHosts: z.array(z.string()).default([]),
    stt: ProviderDescriptorSchema.optional(),
    llm: ProviderDescriptorSchema.optional(),
    tts: ProviderDescriptorSchema.optional(),
    s2s: ProviderDescriptorSchema.optional(),
    mode: z.enum(["s2s", "pipeline"]).optional(),
    kv: ProviderDescriptorSchema.optional(),
    vector: ProviderDescriptorSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    function fail(message: string): void {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    try {
      const mode = assertProviderTriple(cfg.stt, cfg.llm, cfg.tts, cfg.s2s);
      if (cfg.mode === "pipeline" && mode !== "pipeline") {
        fail("mode='pipeline' requires stt, llm, and tts to be set");
      }
    } catch (err) {
      fail(errorMessage(err));
    }
  });

export type IsolateConfig = z.infer<typeof IsolateConfigSchema>;

export const ToolCallResponseSchema = z.object({
  result: z.string(),
  state: z.record(z.string(), z.unknown()),
});

export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;

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

const rpcEnvelope = { id: z.string(), type: z.literal("kv") };

export const KvRequestSchema = z.discriminatedUnion("op", [
  KvGetSchema.extend(rpcEnvelope),
  KvSetSchema.extend(rpcEnvelope),
  KvDelSchema.extend(rpcEnvelope),
  z.object({ ...rpcEnvelope, op: z.literal("mget"), keys: z.array(z.string()) }),
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

// Host trusts its own outgoing tool-call requests, so no Zod schema.
export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: { role: "user" | "assistant" | "tool"; content: string }[];
};
