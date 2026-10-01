// Copyright 2026 the AAI authors. MIT license.
/**
 * `streamText` takes ONE `prepareStep`, and this package has more than one
 * thing to say per step.
 *
 * The AI SDK's per-step hook is a single slot: a second caller does not add a
 * layer, it REPLACES the first. The voice pipeline has six concerns that want
 * it (the context budget, the agent-scoped `toolChoice` reset, the persona's
 * and the dialog state's knobs, the tool-error budget, `forceFinalAnswer`), the
 * text agent three, a subagent one. Writing any of them directly into the slot
 * silently deletes the others, and every such failure is invisible (a turn
 * that stops mid-chain with an empty transcript; a request that overflows the
 * model's window; a dialog pin that stops applying after step 0).
 *
 * So the slot is filled only by {@link composePreparers}, a pipeline every
 * concern REGISTERS into by stage, whose order ({@link PREPARER_ORDER}) is
 * decided once here rather than by the order a call site lists things in.
 * `guard-invariants` rule 35 holds every `prepareStep:` in this package to it.
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
 * Every per-step concern this package has, in the ORDER they are layered.
 *
 * The order is ONE decision, made here, rather than a convention each call
 * site re-derives: {@link composePreparers} sorts what it is handed into this
 * order, so a call site registers its concerns and cannot get the precedence
 * wrong by listing them wrong. That is the bug this replaced — the dialog
 * state's knobs were once composed BEFORE the agent-scoped reset, which then
 * overwrote a state's `toolChoice` pin with `"auto"` from step 1 on, on every
 * agent whose own `toolChoice` demanded something.
 *
 * Last writer wins per key, so the rule is `ToolChoice`'s documented scope
 * precedence (agent → persona → dialog state → forced answers) written out:
 *
 * 1. `caller` — a text-agent caller's own `prepareStep` (compaction, deadline
 *    notices). First, so everything below layers over what it decided.
 * 2. `context-budget` — owns `messages`, and shares no key with those below.
 * 3. `agent-tool-choice` — {@link resetToolChoiceAfterFirstStep}, the AGENT
 *    scope.
 * 4. `persona` — the active persona's knobs: who is speaking is broader than
 *    where in their script they are.
 * 5. `dialog` — the active dialog state's knobs, which beat the agent's and the
 *    persona's for exactly as long as the conversation is in that state.
 * 6. `tool-error-budget` — {@link toolErrorBudget}: a state pinning a tool must
 *    not keep the model calling one that cannot succeed.
 * 7. `force-final-answer` — {@link forceFinalAnswer}, which owns `toolChoice`
 *    on the one reserved step and must win there over everything. It and the
 *    error budget both force `"none"`, so their relative order changes no
 *    request.
 */
export const PREPARER_ORDER = [
  "caller",
  "context-budget",
  "agent-tool-choice",
  "persona",
  "dialog",
  "tool-error-budget",
  "force-final-answer",
] as const;

/** One of the {@link PREPARER_ORDER} stages. */
export type PreparerStage = (typeof PREPARER_ORDER)[number];

/**
 * A per-step concern, registered by STAGE.
 *
 * `prepare` may be `undefined` — "this concern does not apply to this session"
 * (no persona roster, an agent with no demanding `toolChoice`) — so a call site
 * registers every concern unconditionally and the absent ones cost nothing.
 */
export interface Preparer {
  readonly stage: PreparerStage;
  readonly prepare: PrepareStepFunction<ToolSet> | undefined;
}

/**
 * The ONE way to fill `streamText`'s (or `ToolLoopAgent`'s) `prepareStep` slot.
 *
 * The AI SDK's per-step hook is a single slot: a second writer does not add a
 * layer, it REPLACES the first, silently. So every concern registers here and
 * this builds the slot's one function — `guard-invariants` rule 35 rejects a
 * `prepareStep:` property in this package whose value is anything else.
 *
 * - **Order is {@link PREPARER_ORDER}, whatever order the registrations
 *   arrive in.** Results layer LAST writer wins per key.
 * - **A stage may be registered at most once**; a duplicate throws at
 *   construction, because two writers for one stage is exactly the ambiguity
 *   the order exists to remove.
 * - **An `undefined` preparer is skipped**, and a preparer answering
 *   `undefined` ("nothing to say about this step") contributes no keys rather
 *   than erasing the ones before it — the rule a hand-rolled `a ?? b` merge
 *   gets wrong.
 */
export function composePreparers(preparers: readonly Preparer[]): PrepareStepFunction<ToolSet> {
  const seen = new Set<PreparerStage>();
  for (const { stage } of preparers) {
    if (seen.has(stage)) throw new Error(`prepareStep stage "${stage}" registered twice`);
    seen.add(stage);
  }
  const ordered = [...preparers]
    .sort((a, b) => PREPARER_ORDER.indexOf(a.stage) - PREPARER_ORDER.indexOf(b.stage))
    .flatMap(({ prepare }) => (prepare === undefined ? [] : [prepare]));
  return async (options) => {
    let merged: NonNullable<PrepareStepResult<ToolSet>> = {};
    for (const prepare of ordered) {
      const result = await prepare(options);
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
