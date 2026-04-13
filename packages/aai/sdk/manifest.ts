// Copyright 2025 the AAI authors. MIT license.
/**
 * Canonical manifest format for directory-based agents.
 *
 * Flows from build → host → sdk. Validated via Zod at the boundary,
 * then used as a plain typed object throughout the runtime.
 */

import { z } from "zod";
import { BuiltinToolSchema, DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./types.ts";

/**
 * Tool definition as it appears in the serialized manifest JSON.
 *
 * This is the JSON-safe representation. Compare with `ToolDef` (in types.ts)
 * which uses Zod schemas for parameters — `agentToolsToSchemas()` in
 * `_internal-types.ts` converts ToolDef → ToolSchema (JSON Schema) for transport.
 */
export type ToolManifest = {
  description: string;
  parameters?: Record<string, unknown> | undefined;
};

/** Normalized agent manifest — all optional fields resolved to defaults. */
export type Manifest = {
  /** Agent display name (from `agent({ name: "..." })`). */
  name: string;
  /** System prompt sent to the LLM. Defaults to {@link DEFAULT_SYSTEM_PROMPT}. */
  systemPrompt: string;
  /** Initial greeting spoken to the user on connect. Defaults to {@link DEFAULT_GREETING}. */
  greeting: string;
  /** Optional prompt hint for the STT engine (improves transcription of domain terms). */
  sttPrompt?: string | undefined;
  /** Enabled built-in tools: `web_search`, `visit_webpage`, `fetch_json`, `run_code`. */
  builtinTools: string[];
  /** Max tool calls per LLM reply. Prevents runaway loops. Default: 5. */
  maxSteps: number;
  /** `"auto"` = LLM decides when to use tools; `"required"` = always call a tool. */
  toolChoice: "auto" | "required";
  /** Idle timeout in ms before auto-closing the session. `undefined` = use default (5 min). */
  idleTimeoutMs?: number | undefined;
  /** CSS custom properties for agent UI theming. */
  theme?: Record<string, string> | undefined;
  /** Custom tool definitions keyed by tool name. */
  tools: Record<string, ToolManifest>;
};

const ToolManifestSchema = z.object({
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const ManifestSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().optional(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  builtinTools: z.array(BuiltinToolSchema).optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: z.enum(["auto", "required"]).optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  theme: z.record(z.string(), z.string()).optional(),
  tools: z.record(z.string(), ToolManifestSchema).optional(),
});

/**
 * Parse and normalize a raw agent manifest, applying defaults for all
 * optional fields. Input is typically the JSON from a bundled agent.ts.
 *
 * Key defaults:
 * - `maxSteps`: 5 — prevents runaway tool-call loops in a single reply
 * - `toolChoice`: "auto" — LLM decides when to use tools vs respond directly
 * - `builtinTools`: [] — no built-in tools unless explicitly opted in
 */
export function parseManifest(input: unknown): Manifest {
  const parsed = ManifestSchema.parse(input);
  return {
    name: parsed.name,
    systemPrompt: parsed.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    greeting: parsed.greeting ?? DEFAULT_GREETING,
    sttPrompt: parsed.sttPrompt,
    builtinTools: parsed.builtinTools ?? [],
    maxSteps: parsed.maxSteps ?? 5,
    toolChoice: parsed.toolChoice ?? "auto",
    idleTimeoutMs: parsed.idleTimeoutMs,
    theme: parsed.theme,
    tools: parsed.tools ?? {},
  };
}
