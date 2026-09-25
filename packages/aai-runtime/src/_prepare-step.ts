// Copyright 2026 the AAI authors. MIT license.
/**
 * `streamText` takes ONE `prepareStep`, and this package has more than one
 * thing to say per step.
 *
 * The AI SDK's per-step hook is a single slot: a second caller does not add a
 * layer, it REPLACES the first. Two things want it in the voice pipeline —
 * `forceFinalAnswer`, which spends the reserved step on an answer with no
 * tools, and the context budget, which decides which messages this step may
 * send — and a third, a caller's own `prepareStep`, on the text agent's door.
 * Composing them is therefore not a convenience: writing either one directly
 * into the slot silently deletes the other, and both failures are invisible
 * (a turn that stops mid-chain with an empty transcript; a request that
 * overflows the model's window).
 *
 * The combinator used to be a private function in `text-agent.ts` composing
 * exactly two. It is shared and variadic now, so the pipeline's pair and the
 * text agent's pair are the same code, and the one test that a composition
 * keeps BOTH results covers both call sites.
 *
 * {@link forceFinalAnswer} sits beside it — the preparer every one of those
 * call sites ends with. It came out of `pipeline-llm-stream.ts`, which three
 * modules imported it from and which the context budget took past the file-line
 * cap; a preparer belongs with the seam that composes preparers rather than
 * inside the one turn assembler that happens to have declared it first.
 * {@link toolErrorBudget}, the voice pipeline's other forced answer, sits here
 * for the same reason.
 */

import type { ToolChoice } from "@alexkroman1/aai";
import { isRecord, isToolFailure, safeJsonParse } from "@alexkroman1/aai/utils";
import type { PrepareStepFunction, PrepareStepResult, ToolSet } from "ai";
import type { Logger } from "./runtime-config.ts";

/**
 * Run each preparer in order and layer their results, LAST writer winning per
 * key.
 *
 * The order is the point, and it is the caller's to choose. A preparer that
 * owns the step's MESSAGES — compaction, a context budget, an injected wrap-up
 * notice — must run early and keep what it returned; nothing legitimately owns
 * `toolChoice` on the step the budget reserved for answering, because that step
 * exists precisely so the model has no move left but to speak. So
 * `forceFinalAnswer` goes LAST at every call site and wins on the one key it
 * sets, while every other key passes through untouched.
 *
 * An `undefined` preparer is skipped (the text agent's caller hook is
 * optional), and a preparer answering `undefined` — "nothing to say about this
 * step" — contributes no keys rather than erasing the ones before it. That
 * second rule is the one a hand-rolled merge gets wrong: `a ?? b` would drop
 * everything `a` said the moment `b` had an opinion.
 */
export function composePrepareStep(
  ...preparers: readonly (PrepareStepFunction<ToolSet> | undefined)[]
): PrepareStepFunction<ToolSet> {
  return async (options) => {
    let merged: NonNullable<PrepareStepResult<ToolSet>> = {};
    for (const preparer of preparers) {
      const result = await preparer?.(options);
      if (result) merged = { ...merged, ...result };
    }
    return merged;
  };
}

/**
 * Put a DEMANDING `toolChoice` back to `"auto"` after the first step.
 *
 * `streamText` applies the request's `toolChoice` to every step, so
 * `toolChoice: "required"` re-obliges the model to call a tool after it already
 * has — and again, and again, until the whole `maxSteps` budget is gone and
 * {@link forceFinalAnswer} spends the reserved step on an answer. Bounded, not
 * a loop; but the caller waits through every round trip, and what the setting
 * almost always means is "start by calling something".
 *
 * Returns `undefined` — contributing no keys at all — when there is nothing to
 * reset: `"auto"` and `"none"` are not demands, and an agent that set no
 * `toolChoice` has the default `"auto"`. That is what makes this safe to
 * compose in unconditionally and safe to default ON.
 *
 * Composed BEFORE {@link forceFinalAnswer}, which owns the same key on the one
 * step it fires for: the reserved step must have no tools at all, and `"auto"`
 * there would let the model spend it on another call.
 *
 * @internal
 */
export function resetToolChoiceAfterFirstStep(
  toolChoice: ToolChoice,
  enabled: boolean,
): ((opts: { stepNumber: number }) => { toolChoice: "auto" } | undefined) | undefined {
  const demands = toolChoice !== "auto" && toolChoice !== "none";
  if (!(enabled && demands)) return undefined;
  return ({ stepNumber }) => (stepNumber === 0 ? undefined : { toolChoice: "auto" });
}

/**
 * Spend the step after the tool budget on an answer the caller can hear.
 *
 * `stopWhen: stepCountIs(n)` alone stops the turn the moment the budget runs
 * out — including mid-chain, right after a tool result, with no text emitted.
 * Nothing downstream can repair that: the reply completes "successfully" with
 * an empty transcript, so `errorPhrase` does not fire either, and the caller
 * hears the agent simply stop. The lower the cap, the more often that happens,
 * which is why it and this function are one change (see DEFAULT_MAX_STEPS).
 *
 * So the budget passed to `stopWhen` is `maxSteps + 1`, and this forces
 * `toolChoice: "none"` on that extra step: the model still has every tool
 * result in context, but its only remaining move is to speak. Same shape as
 * LiveKit's behaviour on `max_tool_steps` since 1.4.5.
 *
 * It costs nothing in the ordinary case — p50 is one step, so a turn that
 * never approaches the cap never reaches this callback. The override also
 * wins over an agent-level `toolChoice: "required"`, which would otherwise
 * demand a tool call on the one step where tools are unavailable.
 */
export function forceFinalAnswer(
  maxSteps: number,
  log: Logger,
  sid: string,
): (opts: { stepNumber: number }) => { toolChoice: "none" } | undefined {
  return ({ stepNumber }) => {
    if (stepNumber < maxSteps) return;
    log.info("maxSteps reached; forcing a final answer with no tools", { maxSteps, sid });
    return { toolChoice: "none" };
  };
}

/**
 * How many failed tool results one turn may collect before its next step is
 * spent on an answer. Internal, not a knob — see {@link toolErrorBudget}.
 */
export const TOOL_ERROR_BUDGET = 3;

/** The slice of a finished step {@link toolErrorBudget} reads: its content. */
type ToolErrorBudgetStep = { readonly content: readonly unknown[] };

/**
 * Stop a turn that keeps calling tools that keep failing, and make it speak.
 *
 * In a voice turn every tool round trip is silence the caller sits through —
 * at best a filler line — and a model that has been refused tends to try
 * again: the same call with the same arguments after an `Error: ...` result,
 * or a string of identity lookups that each come back empty, while the caller
 * asks whether anyone is still there. `forceFinalAnswer` bounds that only at
 * `maxSteps`, which is long enough to lose the caller.
 *
 * So the next step is forced to `toolChoice: "none"` — the model keeps every
 * result in context, and its only move is to tell the caller what happened —
 * as soon as EITHER:
 *
 * - the step just finished repeats a call (same tool, same canonical-JSON
 *   arguments) that already FAILED earlier in this turn — a retry that cannot
 *   answer differently; or
 * - {@link TOOL_ERROR_BUDGET} tool results in this turn have failed.
 *
 * "This turn" is `steps`, which the AI SDK scopes to one `streamText` call, so
 * failures in earlier turns never count: a caller who corrects their details
 * gets a fresh budget. See {@link isFailedToolResult} for what a failure is.
 *
 * Returns a fresh preparer per call, because it logs once per TURN: build one
 * per request, never one per session.
 *
 * @internal
 */
export function toolErrorBudget(
  log: Logger,
  sid: string,
): (opts: { steps: readonly ToolErrorBudgetStep[] }) => { toolChoice: "none" } | undefined {
  let fired = false;
  return ({ steps }) => {
    const last = steps.at(-1);
    if (last === undefined) return;
    const failed = new Set<string>();
    let errors = 0;
    for (const step of steps.slice(0, -1)) errors += collectFailures(step, failed);
    const identicalRepeat = last.content.some(
      (part) => isToolPart(part) && part.type === "tool-call" && failed.has(callKey(part)),
    );
    errors += collectFailures(last, failed);
    if (!(identicalRepeat || errors >= TOOL_ERROR_BUDGET)) return;
    if (!fired) {
      fired = true;
      log.info("tool-error budget spent; forcing an answer", { sid, errors, identicalRepeat });
    }
    return { toolChoice: "none" };
  };
}

/** A tool part of a step's content, narrowed to the fields this reads. */
type ToolPart = { type: string; toolName?: unknown; input?: unknown; output?: unknown };

function isToolPart(part: unknown): part is ToolPart {
  return isRecord(part) && typeof part.type === "string";
}

/** Add each failed call in `step` to `failed` by key; return how many failed. */
function collectFailures(step: ToolErrorBudgetStep, failed: Set<string>): number {
  let count = 0;
  for (const part of step.content) {
    if (!isToolPart(part)) continue;
    const isFailure =
      part.type === "tool-error" ||
      (part.type === "tool-result" && isFailedToolResult(part.output));
    if (!isFailure) continue;
    failed.add(callKey(part));
    count += 1;
  }
  return count;
}

/** `(toolName, canonical-JSON input)` — key order does not make a call new. */
function callKey(part: ToolPart): string {
  return JSON.stringify([part.toolName, canonicalJson(part.input)]);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key]);
  return sorted;
}

/**
 * Whether a `tool-result` part's output is a failure the model was handed.
 *
 * Three shapes, because three producers reach a step's content:
 *
 * - this runtime's own failures — a throw, a refused schema, a cancelled or
 *   unknown call, a relay that could not dispatch — all resolve to the
 *   `serializeToolFailure` string `{"error":"..."}`, and an author's returned
 *   `toolFailure(...)` object is the same shape before it is serialized. That
 *   is the test `tool-messages-runner.ts` already uses to pick a `failed` line;
 * - a string that starts with `Error` (case-sensitive, after trimming) — the
 *   conventional shape of a tool's own error text;
 * - a model-message tool output (`{ type, value }`): `error-text` and
 *   `error-json` are failures by declaration, and a `value` string is judged
 *   by the two rules above.
 *
 * A `tool-error` part — the AI SDK's own arm for a call whose `execute`
 * rejected — needs no inspection and is counted by the caller.
 */
export function isFailedToolResult(output: unknown): boolean {
  if (typeof output === "string") {
    return output.trim().startsWith("Error") || isToolFailure(safeJsonParse(output));
  }
  if (!isRecord(output)) return false;
  if (output.type === "error-text" || output.type === "error-json") return true;
  if (typeof output.value === "string") return isFailedToolResult(output.value);
  return isToolFailure(output);
}
