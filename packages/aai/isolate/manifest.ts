// Copyright 2025 the AAI authors. MIT license.
/**
 * Canonical manifest format for directory-based agents.
 *
 * Flows from build → host → isolate. Validated via Zod at the boundary,
 * then used as a plain typed object throughout the runtime.
 */

import { z } from "zod";
import { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./types.ts";

export type ToolManifest = {
  description: string;
  parameters?: Record<string, unknown>;
};

export type HookFlags = {
  onConnect: boolean;
  onDisconnect: boolean;
  onUserTranscript: boolean;
  onError: boolean;
};

export type Manifest = {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string;
  builtinTools: string[];
  maxSteps: number;
  toolChoice: "auto" | "required";
  idleTimeoutMs?: number;
  theme?: Record<string, string>;
  tools: Record<string, ToolManifest>;
  hooks: HookFlags;
};

const ToolManifestSchema = z.object({
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const HookFlagsSchema = z.object({
  onConnect: z.boolean(),
  onDisconnect: z.boolean(),
  onUserTranscript: z.boolean(),
  onError: z.boolean(),
});

const BUILTIN_TOOLS = ["web_search", "visit_webpage", "fetch_json", "run_code"] as const;

const ManifestSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().optional(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  builtinTools: z.array(z.enum(BUILTIN_TOOLS)).optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: z.enum(["auto", "required"]).optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  theme: z.record(z.string(), z.string()).optional(),
  tools: z.record(z.string(), ToolManifestSchema).optional(),
  hooks: HookFlagsSchema.optional(),
});

const DEFAULT_HOOKS: HookFlags = {
  onConnect: false,
  onDisconnect: false,
  onUserTranscript: false,
  onError: false,
};

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
    hooks: parsed.hooks ?? DEFAULT_HOOKS,
  };
}
