// Copyright 2025 the AAI authors. MIT license.
/**
 * System prompt builder for S2S sessions.
 */

import type { AgentConfig } from "./_internal-types.ts";
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

// Cache the formatted date string — same for all sessions on a given day.
let _cachedDate = "";
let _cachedDateDay = -1;

function getFormattedDate(): string {
  const now = new Date();
  const day = now.getDate();
  if (day !== _cachedDateDay) {
    _cachedDate = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    _cachedDateDay = day;
  }
  return _cachedDate;
}

const VOICE_RULES =
  "\n\nCRITICAL OUTPUT RULES — you MUST follow these for EVERY response:\n" +
  "Your response will be spoken aloud by a TTS system and displayed as plain text.\n" +
  "- NEVER use markdown: no **, no *, no _, no #, no `, no [](), no ---\n" +
  "- NEVER use bullet points (-, *, •) or numbered lists (1., 2.)\n" +
  "- NEVER use code blocks or inline code\n" +
  "- NEVER mention tools, search, APIs, or technical failures to the user. " +
  "If a tool returns no results, just answer naturally without explaining why.\n" +
  "- Write exactly as you would say it out loud to a friend\n" +
  '- Use short conversational sentences. To list things, say "First," "Next," "Finally,"\n' +
  "- Keep responses concise — 1 to 3 sentences max";

/**
 * Build the system prompt sent to the LLM from the agent configuration.
 *
 * Assembles the default instructions, today's date, agent-specific instructions,
 * and optional sections for tool usage preamble and voice output rules.
 *
 * @param config - The serializable agent configuration (name, instructions, etc.).
 * @param opts.hasTools - When `true`, appends a preamble instructing the LLM to
 *   speak a brief phrase before each tool call to fill silence.
 * @param opts.voice - When `true`, appends strict voice-specific output rules
 *   (no markdown, no bullet points, conversational tone, concise responses).
 * @returns The assembled system prompt string.
 */
export function buildSystemPrompt(
  config: AgentConfig,
  opts: { hasTools: boolean; voice?: boolean },
): string {
  const { hasTools } = opts;
  const agentInstructions =
    config.instructions && config.instructions !== DEFAULT_INSTRUCTIONS
      ? `\n\nAgent-Specific Instructions:\n${config.instructions}`
      : "";

  const toolPreamble = hasTools
    ? "\n\nWhen you decide to use a tool, ALWAYS say a brief natural phrase BEFORE the tool call " +
      '(e.g. "Let me look that up" or "One moment while I check"). ' +
      "This fills silence while the tool executes. Keep preambles to one short sentence."
    : "";

  const today = getFormattedDate();

  return (
    DEFAULT_INSTRUCTIONS +
    `\n\nToday's date is ${today}.` +
    agentInstructions +
    toolPreamble +
    (opts.voice ? VOICE_RULES : "")
  );
}
