// Copyright 2026 the AAI authors. MIT license.
/**
 * What a tool's RETURN VALUE becomes: the string the provider reads, and the
 * one warning the framework says about its size.
 *
 * Split out of `tool-executor.ts` when that file crossed the 500-line source
 * cap, on the seam a reader already uses there — everything left is about
 * RUNNING a tool or classifying its failure, and this is about shaping what it
 * answered. `warnedOversizedTools` travels with the function that owns it, so
 * the once-per-process latch cannot be reset by an unrelated import.
 *
 * @module
 */

import { MAX_TOOL_RESULT_CHARS } from "@alexkroman1/aai/internal";
import type { Logger } from "./runtime-config.ts";

/**
 * Tool names already warned about by {@link warnOversizedResult}, so a chatty
 * tool costs one line for the life of the process rather than one per call.
 *
 * Process-wide rather than per session, deliberately: tool bodies run in the
 * agent's OWN guest sandbox (or its `aai dev` / self-hosted runtime), one agent
 * per process, so a name here cannot suppress another tenant's first warning.
 * Bounded by the tool roster, which is fixed at deploy time.
 */
const warnedOversizedTools = new Set<string>();

/**
 * Say — once per tool — that a result is larger than the cap, because the cap
 * does not apply to the copy that matters.
 *
 * `MAX_TOOL_RESULT_CHARS` bounds the CLIENT's `tool.completed` frame
 * (`capToolResult`, in `session-tool-steps.ts` and the pipeline stream) and
 * nothing else. The string this module returns goes to the provider WHOLE and
 * is appended to the conversation, so it is re-sent on every later turn of the
 * call: an unshaped `await res.json()` is the whole response, in the prompt,
 * for the rest of the turn. Two published docs promised the cap applied to both
 * sides, which is what made that shape look free.
 *
 * A warning rather than a cap: the framework cannot tell a deliberately large
 * result (a transcript a subagent summarizes, a table a later step reads) from a
 * forgotten projection, and silently trimming the first would corrupt data an
 * author is relying on — the same argument `assemblyAIVoiceWarning` makes for
 * saying something about a voice it may not refuse. Capping here is a behaviour
 * change and needs a decision, not a patch.
 *
 * Logged, not emitted as a session error: nothing is broken, and the reader is
 * whoever is watching the build or the server log.
 */
export function warnOversizedResult(
  name: string,
  result: string,
  logger: Logger | undefined,
): void {
  if (result.length <= MAX_TOOL_RESULT_CHARS || warnedOversizedTools.has(name)) return;
  warnedOversizedTools.add(name);
  const message =
    `Tool "${name}" returned ${result.length} characters, over MAX_TOOL_RESULT_CHARS ` +
    `(${MAX_TOOL_RESULT_CHARS}). The model receives the WHOLE result and re-reads it on every ` +
    "later turn of this call; only the client's tool.completed frame is truncated. If this is an " +
    "unshaped API response, return the fields the model needs.";
  if (logger) logger.warn(message, { tool: name, chars: result.length });
  else console.warn(`[tool-executor] ${message}`);
}

export function stringifyResult(result: unknown): string {
  if (result == null) return "null";
  if (typeof result === "string") return result;
  // JSON.stringify returns undefined for functions/symbols — fall back to
  // String() so the provider always gets a string, never `undefined`.
  return JSON.stringify(result) ?? String(result);
}
