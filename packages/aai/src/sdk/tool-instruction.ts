// Copyright 2026 the AAI authors. MIT license.
/**
 * A per-outcome INSTRUCTION to the model, carried by a tool result.
 *
 * A tool often knows, at the moment it answers, how the model should treat
 * what it answered: "read the plan back in one breath", "do not list every
 * row, name the count", "ask which of these two before going on". Before this
 * module there were three ways to say it and none was the SDK's: a `messages`
 * entry with `role: "system"` (one sentence per tool, fixed at declaration —
 * not per outcome), a dialog state's `instruction` (per STATE, and only for a
 * `dialog.tool`), or a field the author invented and the prompt begged the
 * model to read. `withInstruction(value, "…")` is the one spelling: the
 * sentence rides on the result under a RESERVED key, the runtime renders it to
 * the model beside the result the way a tool message's `[guidance]` hint is
 * rendered, and strips it from everything that is not the model — the
 * `tool.completed` frame a page renders, the `role: "tool"` message a later
 * tool reads through `ctx.messages`, the session's event log.
 *
 * The key is `$instruction`, reserved by the dollar prefix the same way the
 * wire's own keys are: a tool's own data never starts with one, so a result
 * that carries the key carries an instruction and nothing else can be
 * mistaken for one.
 *
 * {@link instructionOf} and {@link stripInstruction} are the readers, shared
 * with the runtime so the three agree on the key.
 *
 * @module
 */

import { isRecord } from "./is-record.ts";

/**
 * The key {@link withInstruction} writes — reserved, and never a tool's own.
 *
 * @public
 */
export const INSTRUCTION_KEY = "$instruction";

/**
 * A tool result carrying a per-outcome instruction to the model — what
 * {@link withInstruction} returns. The result's own fields are untouched; the
 * instruction is one more key, reserved, that the runtime removes before a
 * page or a later tool reads the value.
 *
 * @sealed
 * @public
 */
export type WithInstruction<T extends Record<string, unknown>> = T & {
  readonly [INSTRUCTION_KEY]: string;
};

/**
 * Attach a per-outcome instruction to a tool result.
 *
 * Returned from `execute` in place of the bare value. The model reads the
 * instruction beside the result; the page and every later tool read the
 * result alone. A failure may carry one too — `withInstruction(toolFailure("No
 * such order."), "Ask for the order number again, digit by digit.")` is still a
 * `ToolFailure` to {@link isToolFailure}.
 *
 * **Per OUTCOME, not per tool.** A sentence that is the same on every call
 * belongs in the tool's `description` or in `messages` with `role: "system"`;
 * this is for the sentence the tool only knows once it has the answer.
 *
 * Throws on a blank instruction: a reserved key with nothing in it would be
 * stripped on the way out and the author would learn nothing.
 *
 * @example
 * ```ts
 * import { tool, withInstruction } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Draft the day's plan",
 *   inputSchema: z.object({ goals: z.array(z.string()) }),
 *   execute: ({ goals }) =>
 *     withInstruction(
 *       { steps: goals.map((goal, i) => `${i + 1}. ${goal}`) },
 *       "Read the plan back in one breath, then ask whether to start.",
 *     ),
 * });
 * ```
 *
 * A result built from several arms (a union) keeps its event field only when
 * EVERY arm spells it: the intersection this returns stops TypeScript's
 * object-literal normalisation, so an arm that stays put writes
 * `next: undefined` rather than omitting the key.
 *
 * @public
 */
export function withInstruction<T extends Record<string, unknown>>(
  value: T,
  instruction: string,
): WithInstruction<T> {
  if (instruction.trim() === "") {
    throw new Error(
      "A blank instruction was handed to withInstruction. Write the sentence the model " +
        "should follow, or return the value alone.",
    );
  }
  return { ...value, [INSTRUCTION_KEY]: instruction };
}

/**
 * The instruction a tool result carries, or `undefined` when it carries none.
 *
 * Structural, so it reads a result that crossed a JSON round trip (the
 * runtime's own copy is a string by the time it looks) as well as the object
 * `execute` returned. A non-record, or a `$instruction` that is not a string,
 * answers `undefined`.
 *
 * @public
 */
export function instructionOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const instruction = result[INSTRUCTION_KEY];
  return typeof instruction === "string" ? instruction : undefined;
}

/**
 * The tool result WITHOUT its instruction — a new object, the caller's
 * untouched. A result carrying none, or that is no record at all, is returned
 * as it was.
 *
 * The runtime calls this on the copy a page and a later tool read; a spec
 * calls it to assert on a tool's data without restating the key.
 *
 * @public
 */
export function stripInstruction<T extends Record<string, unknown>>(
  result: T,
): Omit<T, typeof INSTRUCTION_KEY>;
export function stripInstruction(result: unknown): unknown;
export function stripInstruction(result: unknown): unknown {
  if (!(isRecord(result) && INSTRUCTION_KEY in result)) return result;
  const { [INSTRUCTION_KEY]: _instruction, ...rest } = result;
  return rest;
}
