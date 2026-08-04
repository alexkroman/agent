// Copyright 2025 the AAI authors. MIT license.
/**
 * System prompt builder for S2S sessions.
 */

import type { AgentConfig } from "./_internal-types.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./types.ts";

const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
};

const TOOL_PREAMBLE =
  "\n\nWhen you decide to use a tool, ALWAYS say a brief natural phrase BEFORE the tool call " +
  '(e.g. "Let me look that up" or "One moment while I check"). ' +
  "This fills silence while the tool executes. Keep preambles to one short sentence.\n" +
  "\nNEVER tell the caller an action is done unless a tool call returned a successful result for " +
  "it. Announcing an action is not performing it: if you say you are looking something up, " +
  "booking, changing, moving, or cancelling it, you MUST make the matching tool call in that same " +
  "turn. If you did not call the tool, or it returned an error, say what you still need — do not " +
  "describe the action as complete. Never state a confirmation number, price, total, seat, or " +
  "other detail that did not come from a tool result; if you need one, call the tool that returns " +
  "it. Carrying something over (a seat, a bag allowance, a preference) is itself an action: it " +
  "needs its own tool call, and does not happen because a related call succeeded.\n" +
  "\nWhen the caller speaks an identifier — an order or confirmation number, a product code, an " +
  "email — write it in its normal written form in the tool argument, not as it was spoken. Drop " +
  'spoken separators ("K dash 2" is K2, "P dash five dash two" is P52) and join spelled-out ' +
  'letters and digits ("A B C one two three" is ABC123). Add nothing the caller did not say: ' +
  '"Z K 3 F F W" is ZK3FFW, never ZEDK3FFW. Write personal names in ordinary title case ' +
  '("Rivera", not "rivera"), matching how the record would store them.';

const VOICE_RULES =
  "\n\nCRITICAL OUTPUT RULES — you MUST follow these for EVERY response:\n" +
  "Your response will be spoken aloud by a TTS system and displayed as plain text.\n" +
  "- NEVER use markdown: no **, no *, no _, no #, no `, no [](), no ---\n" +
  "- NEVER use bullet points (-, *, •) or numbered lists (1., 2.)\n" +
  "- NEVER use code blocks or inline code\n" +
  "- NEVER mention tools, search, APIs, or technical failures to the user. " +
  "If a tool returns no results, just answer naturally without explaining why.\n" +
  "- Write exactly as you would say it out loud to a friend\n" +
  '- NEVER use contractions. Write every word out in full: "I will" not "I\'ll", ' +
  '"cannot" not "can\'t", "it is" not "it\'s", "do not" not "don\'t"\n' +
  '- Use short conversational sentences. To list things, say "First," "Next," "Finally,"\n' +
  "- Keep responses concise — 1 to 3 sentences max\n" +
  "- Do NOT read out long lists. When a tool returns several items, say how many there are, name " +
  "at most two, and ask which one they mean " +
  '(e.g. "There are five items on that order — the headphones and the vacuum, plus three more. ' +
  'Which one do you want to return?"). Reading every item invites the caller to interrupt, and ' +
  "everything after the interruption is never heard.\n" +
  "- When the caller spells something (a name, email, or ID) or reads out digits, do NOT " +
  "read the whole thing back letter by letter — it is slow and invites interruptions. " +
  'Confirm briefly and move on (e.g. "Thanks, got it" or "Okay, Yusuf Rossi, ZIP 1-9-1-2-2 — one moment"). ' +
  "Only re-spell a specific character if you need to resolve a genuine ambiguity.";

/**
 * Build the system prompt sent to the LLM from the agent configuration.
 *
 * Assembles the default system prompt, today's date, agent-specific instructions,
 * and optional sections for tool usage preamble and voice output rules.
 *
 * @param config - The serializable agent configuration (name, systemPrompt, etc.).
 * @param opts.hasTools - When `true`, appends a preamble instructing the LLM to
 *   speak a brief phrase before each tool call to fill silence.
 * @param opts.voice - When `true`, appends strict voice-specific output rules
 *   (no markdown, no bullet points, conversational tone, concise responses).
 * @returns The assembled system prompt string.
 */
export function buildSystemPrompt(
  config: AgentConfig,
  opts: { hasTools: boolean; voice?: boolean; toolGuidance?: readonly string[] | undefined },
): string {
  const basePrompt = DEFAULT_SYSTEM_PROMPT;
  const hasCustomPrompt = config.systemPrompt && config.systemPrompt !== basePrompt;
  const agentInstructions = hasCustomPrompt
    ? `\n\nAgent-Specific Instructions:\n${config.systemPrompt}`
    : "";

  const toolPreamble = opts.hasTools ? TOOL_PREAMBLE : "";

  const guidance =
    opts.toolGuidance && opts.toolGuidance.length > 0
      ? `\n\nBuilt-in Tool Usage:\n${opts.toolGuidance.join("\n")}`
      : "";

  const today = new Date().toLocaleDateString("en-US", DATE_FORMAT_OPTIONS);

  return (
    basePrompt +
    `\n\nToday's date is ${today}.` +
    agentInstructions +
    toolPreamble +
    guidance +
    (opts.voice ? VOICE_RULES : "")
  );
}
