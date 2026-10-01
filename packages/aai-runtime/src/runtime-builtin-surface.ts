// Copyright 2026 the AAI authors. MIT license.
/**
 * The builtin tool surface merged with the tools a mode dispatches itself.
 *
 * Its own module because both tool paths read it (`runtime-tools.ts` for the
 * sandbox and self-hosted runtimes, `text-agent.ts` for text mode), and the
 * collision policy it owns has to be the same rule on each.
 *
 * @module
 */

import type { AgentDef, ToolDef } from "@alexkroman1/aai";
import { resolveAllBuiltins } from "@alexkroman1/aai/host-internal";
import { DEFAULT_BUILTIN_TOOLS } from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { Logger } from "./runtime-config.ts";

/**
 * Merge the agent's builtins with the tools a mode dispatches itself — the
 * single owner of the collision policy for every tool path — sandbox/relay,
 * self-hosted, and {@link createTextAgent}. A provided tool with the same name as a builtin wins,
 * and the colliding builtin is dropped from both dispatch and schemas so the
 * host never shadows a tool the caller expects to execute and the LLM never
 * sees a duplicate name. Provided schemas/guidance come first, builtins after.
 *
 * **A dropped builtin is LOGGED**, because the author declared it. `tools/
 * web_search.ts` beside `builtinTools: ["web_search"]` is one of two things — a
 * deliberate replacement, or a file whose name collided by accident — and
 * nothing anywhere said which had happened: the entry in `builtinTools` simply
 * did nothing, and an author debugging "why is my search not the built-in one"
 * (or the reverse) had no thread to pull. The policy itself is unchanged; the
 * file still wins.
 */
export function mergeBuiltinSurface(
  agent: AgentDef,
  builtinOpts: Parameters<typeof resolveAllBuiltins>[1],
  provided: { schemas: ToolSchema[]; guidance?: string[] },
  logger?: Logger | undefined,
): {
  defs: Record<string, ToolDef>;
  schemas: ToolSchema[];
  guidance: string[];
} {
  const providedNames = new Set(provided.schemas.map((s) => s.name));
  const declared = agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS;
  const names = declared.filter((name) => !providedNames.has(name));
  // Only an entry the author WROTE is reported: a `tools/think.ts` beside an
  // unset `builtinTools` is the file replacing the default, which is the
  // policy working, not an entry that silently does nothing.
  const shadowed = (agent.builtinTools ?? []).filter((name) => providedNames.has(name));
  if (shadowed.length > 0) {
    logger?.info?.(
      `builtinTools ${shadowed.map((name) => `"${name}"`).join(", ")} ${shadowed.length === 1 ? "is" : "are"} inert: a tools/ file of the same name is what the model will call. Rename the file if that was not the intent.`,
    );
  }
  const builtins = resolveAllBuiltins(names, builtinOpts);
  return {
    defs: builtins.defs,
    schemas: [...provided.schemas, ...builtins.schemas],
    guidance: [...(provided.guidance ?? []), ...builtins.guidance],
  };
}
