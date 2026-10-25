// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool result's per-outcome INSTRUCTION, split off the string the executor
 * answered with — the runtime half of `withInstruction` (`@alexkroman1/aai`).
 *
 * The executor answers a STRING on every path (that is `ExecuteTool`'s
 * contract, and it crosses an RPC seam in sandbox mode), so the reserved key
 * is still inside the JSON by the time the shared call core sees it. This is
 * where it comes out: the stripped JSON is what the client's `tool.completed`
 * frame, the `role: "tool"` message and the event log carry, and the
 * instruction is appended to the MODEL's copy alone, labelled the way a tool
 * message's `role: "system"` hint is (`TOOL_SYSTEM_HINT_LABEL`) — one more
 * line beside the result rather than a system message spliced into the
 * conversation, for the reason `messages-runner.ts` gives.
 *
 * @module
 */

import { instructionOf, safeJsonParse, stripInstruction } from "@alexkroman1/aai/utils";

/**
 * What a result's instruction is prefixed with in the model's copy. Its own
 * label rather than `[guidance]`: a tool message's hint is the AUTHOR's
 * sentence about the tool, this is the tool's sentence about this answer.
 */
export const TOOL_INSTRUCTION_LABEL = "[instruction]";

/** A result string with its instruction, if any, taken out. */
export type SplitResult = {
  /** The tool's own result — the JSON without the reserved key. */
  result: string;
  /** The instruction it carried, when it carried one. */
  instruction?: string | undefined;
};

/**
 * Take the reserved `$instruction` key out of a result string.
 *
 * A result that is not JSON, not a record, or carries no instruction comes
 * back as it was, by identity — an ordinary tool's result is untouched.
 */
export function splitInstruction(raw: string): SplitResult {
  const parsed = safeJsonParse(raw);
  const instruction = instructionOf(parsed);
  if (instruction === undefined) return { result: raw };
  return { result: JSON.stringify(stripInstruction(parsed)), instruction };
}

/** The model's copy: the shaped result, then the instruction under its label. */
export function withInstructionForModel(shaped: string, instruction: string | undefined): string {
  return instruction === undefined
    ? shaped
    : `${shaped}\n\n${TOOL_INSTRUCTION_LABEL} ${instruction}`;
}
