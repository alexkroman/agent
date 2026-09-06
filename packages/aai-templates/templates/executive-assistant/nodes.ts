/**
 * The nodes that call a MODEL, one function each: their `triage_input`,
 * `rewrite`, `determine_what_to_update` and `update_general`.
 *
 * Every function here is a plain async function of a `GenerateFn` and its
 * arguments, so a spec drives one directly and the tools hold no prompt text.
 * Each passes a distinct `system` — {@link TRIAGE_SYSTEM} and friends — which is
 * what lets `stubGenerate` script the roles apart inside one tool call.
 *
 * What is NOT here is their `draft_response` node: that model is the voice
 * agent itself, and its tool calls are the drafts (see `prompts.ts`). And their
 * `find_meeting_time` is a subagent rather than a generate — `meeting.ts`.
 */

import type { GenerateFn } from "@alexkroman1/aai";
import type { Memory } from "./inbox.ts";
import {
  CHOOSE_MEMORY_SYSTEM,
  chooseMemoryPrompt,
  type Executive,
  formatExamples,
  generalResponse,
  MEMORY,
  type MemoryType,
  memoryToUpdate,
  REWRITE_SYSTEM,
  respondTo,
  reWriteEmail,
  rewritePrompt,
  TRIAGE_SYSTEM,
  type TriageExample,
  type TriageVerdict,
  triagePrompt,
  UPDATE_MEMORY_SYSTEM,
  updateMemoryPrompt,
} from "./prompts.ts";
import type { AssistantState, Reflection } from "./shared.ts";

/** Their `triage_input`, with the few-shot examples already chosen. */
export async function triageEmail(
  generate: GenerateFn,
  exec: Executive,
  email: { from: string; to: string; subject: string; body: string },
  examples: readonly TriageExample[],
): Promise<TriageVerdict> {
  const { object } = await generate({
    system: TRIAGE_SYSTEM,
    prompt: triagePrompt(exec, email, formatExamples(examples)),
    schema: respondTo,
    temperature: 0,
  });
  return object;
}

/**
 * Their `rewrite` node: the same facts in the executive's voice.
 *
 * Takes the tone instructions rather than the memory, so the caller decides
 * which prompt is current — which is the whole point of a memory that changes.
 */
export async function rewriteDraft(
  generate: GenerateFn,
  exec: Executive,
  instructions: string,
  draft: string,
  thread: string,
): Promise<{ toneLogic: string; rewrittenContent: string }> {
  const { object } = await generate({
    system: REWRITE_SYSTEM,
    prompt: rewritePrompt(exec, instructions, draft, thread),
    schema: reWriteEmail,
    temperature: 0,
  });
  return object;
}

/** One prompt the reflection decided to rewrite — their `store.aput`, staged. */
export interface MemoryUpdate {
  type: MemoryType;
  memory: keyof Memory;
  logic: string;
  newPrompt: string;
}

/**
 * Their `multi_reflection_graph`: decide which prompts the feedback touches,
 * then rewrite each one — in parallel, as their `Send` fan-out runs them.
 *
 * Pure of the slot: it READS the current memory and returns the updates, and
 * {@link applyReflection} writes them inside a synchronous window. Their
 * `update_general` picks a reasoning model for this; here it runs on the agent's
 * own `llm`, which a template may not assume a second key for.
 */
export async function reflect(
  generate: GenerateFn,
  input: {
    memory: Memory;
    trajectory: string;
    feedback: string;
    /** Their `prompt_types` — which memories THIS kind of feedback may touch. */
    promptTypes: readonly MemoryType[];
  },
): Promise<MemoryUpdate[]> {
  const chosen = await generate({
    system: CHOOSE_MEMORY_SYSTEM,
    prompt: chooseMemoryPrompt(input.trajectory, input.feedback, input.promptTypes),
    schema: memoryToUpdate,
    temperature: 0,
  });
  // The chooser is offered only the allowed types, and is held to them: a model
  // that names `tone` when told about a calendar preference rewrites nothing.
  const types = [...new Set(chosen.object.memoryTypesToUpdate)].filter((t) =>
    input.promptTypes.includes(t),
  );
  const rewritten = await Promise.all(
    types.map(async (type) => {
      const { key, instructions } = MEMORY[type];
      const { object } = await generate({
        system: UPDATE_MEMORY_SYSTEM,
        prompt: updateMemoryPrompt(
          input.memory[key],
          input.trajectory,
          input.feedback,
          instructions,
        ),
        schema: generalResponse,
        temperature: 0,
      });
      return object.updatePrompt && object.newPrompt.trim() !== ""
        ? { type, memory: key, logic: object.logic, newPrompt: object.newPrompt }
        : undefined;
    }),
  );
  return rewritten.filter((update) => update !== undefined);
}

/** Write what the reflection decided, and remember that it did. */
export function applyReflection(state: AssistantState, updates: readonly MemoryUpdate[]): void {
  for (const update of updates) {
    state.memory[update.memory] = update.newPrompt;
    const reflection: Reflection = { memory: update.memory, logic: update.logic };
    state.reflections.push(reflection);
  }
}

/** What the assistant may SAY about a reflection — one clause per memory touched. */
export function describeUpdates(updates: readonly MemoryUpdate[]): string {
  if (updates.length === 0) return "Nothing new to remember from that.";
  return `Noted — updated ${updates.map((u) => u.type).join(" and ")} preferences: ${updates
    .map((u) => u.logic)
    .join(" ")}`;
}
