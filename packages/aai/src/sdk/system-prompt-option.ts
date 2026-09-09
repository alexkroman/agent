// Copyright 2026 the AAI authors. MIT license.
/**
 * An agent's system prompt as a value or as a THUNK, and the one way to read it.
 *
 * `agent({ systemPrompt })` takes either. A string is what almost every agent
 * writes and is what a `system-prompt.md` lowers onto the definition; a
 * function is for a prompt the author cannot know until the turn is being
 * assembled — the phase a `dialog()` machine is in, a catalog loaded at boot, a
 * roster that changes while the process runs.
 *
 * **A plain string is byte-identical to what shipped before this existed.** It
 * resolves to itself, at the same place the frozen value used to be read, and
 * the runtime's per-day prompt cache still assembles the prompt once. That is
 * what makes the widening free for every agent that does not want it.
 *
 * ## The thunk is resolved PER TURN, and once more at the wire
 *
 * Every transport reads it through {@link resolveSystemPrompt} as it assembles
 * a request, so a thunk that answers differently answers differently on the
 * next turn of the same call — which is the whole point of it over a string
 * computed once at module scope.
 *
 * `toAgentConfig` also calls it ONCE, because `AgentConfig` is the serializable
 * shape and a function cannot cross a wire: the config carries the SNAPSHOT the
 * thunk returned at serialization time. Nothing resolves a prompt from that
 * snapshot at run time — the runtime holds the live definition and re-resolves
 * it per turn — so the snapshot is what a config REPORTS (`aai build`'s
 * prompt-source line, a stored config), never what an agent answers with. Two
 * obligations follow for the author, and they are the price of the feature: a
 * thunk must be callable at any time, including at build time with no session
 * anywhere, and it must return a string.
 *
 * ## Why one spelling for reading it
 *
 * A read site that forgets the call hands a FUNCTION to something that wants a
 * string, and neither the AI SDK nor the OpenAI Realtime API rejects that: it
 * stringifies, so the agent's instructions silently become this module's source
 * text. There is no error, no refusal and no test that fails — the model simply
 * answers fluently under instructions nobody wrote. The union makes a bare read
 * a compile error at every site that has to resolve one, and this function is
 * the only remedy for it.
 */

/**
 * An agent's system prompt: the text, or a function returning it.
 *
 * Resolved per turn, so a thunk may answer differently on each one. See this
 * module's doc for what a thunk owes in exchange — chiefly that it is callable
 * at build time, where the serializable config takes its snapshot.
 *
 * @example A prompt that carries the phase the call is in
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * declare const currentPhase: () => string;
 *
 * export default agent({
 *   name: "Intake",
 *   systemPrompt: () => `You are taking an intake call.\n\nPhase: ${currentPhase()}`,
 * });
 * ```
 *
 * @public
 */
export type SystemPromptOption = string | (() => string);

/**
 * Resolve a {@link SystemPromptOption} at the moment a request is assembled.
 *
 * @param prompt - The declared prompt — a string, or a thunk to call now.
 * @returns The prompt text for this turn.
 *
 * @internal
 */
export function resolveSystemPrompt(prompt: SystemPromptOption): string {
  return typeof prompt === "function" ? prompt() : prompt;
}
