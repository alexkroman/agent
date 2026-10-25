// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent's own section of a system prompt, resolved ONCE per request:
 * the `systemPrompt` half (a string with a leading copy of the default
 * stripped, or a resolver asked with the session) with the `promptContext`
 * half (string or resolver) appended under it, blank-line separated
 * (`appendPromptContext`). `undefined` when the agent declares neither.
 *
 * TODO(integrator): replace with `resolveAgentInstructions` from
 * `@alexkroman1/aai/host-internal` (S1 #17), which has this signature; delete
 * this module and point the two importers (`runtime/system-prompt.ts`,
 * `text-agent/agent.ts`) at it.
 *
 * @internal
 */

import type { AgentPromptContext, AgentSessionContext, AgentSystemPrompt } from "@alexkroman1/aai";
import { appendPromptContext, authorInstructions } from "@alexkroman1/aai/host-internal";

/**
 * The author section for `agent` (an `AgentDef`, or just its two prompt
 * fields), for the request `ctx` describes.
 */
export function resolveAgentInstructions(
  agent: {
    readonly systemPrompt?: AgentSystemPrompt | undefined;
    readonly promptContext?: AgentPromptContext | undefined;
  },
  ctx: AgentSessionContext,
): string | undefined {
  const { systemPrompt, promptContext } = agent;
  // The strip warns once per prompt string, so asking per request is cheap.
  let own: string | undefined;
  if (typeof systemPrompt === "function") own = systemPrompt(ctx);
  else if (systemPrompt !== undefined) own = authorInstructions(systemPrompt);
  const context = typeof promptContext === "function" ? promptContext(ctx) : promptContext;
  return appendPromptContext(own, context);
}
