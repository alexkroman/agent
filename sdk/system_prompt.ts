// Copyright 2025 the AAI authors. MIT license.

import type { AgentConfig } from "./_internal_types.ts";
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

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

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    DEFAULT_INSTRUCTIONS +
    `\n\nToday's date is ${today}.` +
    agentInstructions +
    toolPreamble +
    (opts?.voice ? VOICE_RULES : "")
  );
}
