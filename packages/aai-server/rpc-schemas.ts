// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ guest RPC boundary.
 *
 * The isolate (harness-runtime.ts) is self-contained and uses inline type
 * definitions instead of importing these schemas, so host and guest can
 * evolve independently.
 */

import { AllowedHostsSchema, DEFAULT_SYSTEM_PROMPT, errorMessage } from "@alexkroman1/aai";
import {
  AgentConfigSchema,
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  ToolSchemaSchema,
} from "@alexkroman1/aai/manifest";
import { z } from "zod";

export { ToolSchemaSchema } from "@alexkroman1/aai/manifest";

/**
 * The host↔guest wire format for an agent's config — the canonical
 * `AgentConfigSchema` (sdk/_internal-types.ts) plus the wire-only
 * `toolSchemas`, with a handful of explicit overrides. Deriving via
 * `.extend` (rather than re-declaring the field list) is what makes a new
 * `AgentConfig` field flow through the server by default: the old
 * hand-copied schema was one of the three shapes where an omission was
 * valid TypeScript and a silently dropped field.
 *
 * Every override below either loosens a rule (a *stored* bundle from an
 * older CLI must keep loading — see sandbox-compat.test.ts) or supplies a
 * wire default; none may drop a field.
 */
export const IsolateConfigSchema = AgentConfigSchema.extend({
  // Wire tolerance: older stored configs predate author-time strictness.
  name: z.string(),
  maxSteps: z.number().optional(),
  // Plain strings, not the BuiltinTool enum: a stored bundle may name a
  // builtin this build no longer knows, and that must not stop the agent
  // from loading (unknown names are ignored at resolution).
  builtinTools: z.array(z.string()).optional(),
  // The base schema now defaults these too; the wire keeps its own spellings
  // so platform behavior stays put: a stored config without a greeting speaks
  // none (toRuntimeAgent falls back to ""), never the SDK default phrase.
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().optional(),
  // Re-validated host-side, not trusted: this list arrives from a tenant's
  // bundle and decides that agent's guest egress, so the platform applies
  // the same pattern rules the SDK does rather than assuming the CLI ran
  // them. Rejects protocols, paths, ports, IP literals, bare `*`, and
  // private TLDs; the SSRF guard still screens every request on top.
  allowedHosts: AllowedHostsSchema.default([]),
  // Wire-only: the agent's custom tool schemas ride alongside the config.
  toolSchemas: z.array(ToolSchemaSchema).default([]),
}).superRefine((cfg, ctx) => {
  function fail(message: string): void {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  try {
    const mode = assertProviderTriple(cfg.stt, cfg.llm, cfg.tts, cfg.s2s);
    if (cfg.mode === "pipeline" && mode !== "pipeline") {
      fail("mode='pipeline' requires stt, llm, and tts to be set");
    }
    assertSilencePolicy(mode, cfg.silenceTimeoutMs, cfg.silencePrompt);
    assertPipelineTuning(mode, cfg);
  } catch (err) {
    fail(errorMessage(err));
  }
});

export type IsolateConfig = z.infer<typeof IsolateConfigSchema>;

/**
 * Params for the guest→host `db/query` RPC — one parameterized SQL statement
 * run against the app's provisioned database (ctx.db). Result is the rows
 * array, capped host-side (see sandbox-guest-rpc.ts).
 */
export const DbQueryParamsSchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

export const ToolCallResponseSchema = z.object({
  result: z.string(),
  // Older guest harnesses echoed the full per-session state on every tool
  // response. The host never reads it (the guest's own session-state map is
  // the source of truth), and current guests no longer send it — kept
  // optional so old and new sides interoperate.
  state: z.record(z.string(), z.unknown()).optional(),
});
