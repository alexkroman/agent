// Copyright 2026 the AAI authors. MIT license.
/**
 * A whole tool LOOP, from inside a step — `ctx.delegate` for a workflow body.
 *
 * {@link stepGenerate} is the one-shot a step already had, and the gap beside it
 * was the loop. A step is handed no `ToolContext`, so `ctx.delegate` is
 * unreachable there, and a workflow that needed a model to search-read-search
 * had to hand-roll one: an action schema for the model to pick from, a counter
 * for the budget, a sentence telling it to answer once the budget is spent, and
 * a branch for the turn where it names an action and fills in none of its
 * fields. `research-handoff-agent` wrote exactly that — 82 lines of loop and helpers
 * by itself, and a second model call to compress what they collected — beside a
 * `subagent()` implementation that does all four and is tested.
 *
 * ```ts
 * import { subagent } from "@alexkroman1/aai";
 * import { stepDelegate } from "@alexkroman1/aai/step";
 *
 * const researcher = subagent({
 *   name: "researcher",
 *   systemPrompt: "Research one angle. Search, then read the best pages.",
 *   expectedOutput: "A paragraph of what you found, naming your sources.",
 *   builtinTools: ["web_search", "visit_webpage"],
 *   maxSteps: 6,
 * });
 *
 * export async function investigate(angle: string): Promise<string> {
 *   const { text } = await stepDelegate(researcher, { task: angle });
 *   return text;
 * }
 * ```
 *
 * ## Why a published slot rather than an import
 *
 * The same reason {@link stepReport} and `stepSpeak` are, and a harder version
 * of it. A tool loop is `ToolLoopAgent` from `ai` plus a provider adapter plus
 * the runtime's tool executor, and **every module a `workflows/*.ts` names at
 * module scope rides into the agent bundle** — which is built and shipped on
 * every deploy. That is the budget `@alexkroman1/aai/step` keeps for all of its
 * exports, and it is why `stepGenerate` is a raw `fetch` rather than
 * `ctx.generate`'s client. So the host publishes a runner and this module holds
 * the slot and the types; `aai-runtime`'s `step-delegate.ts` is the other half,
 * and it reuses `createSubagentRunner` — the same implementation `ctx.delegate`
 * runs on, so a subagent cannot behave differently for having been reached from
 * a step.
 *
 * ## Call it INSIDE a `ctx.step`
 *
 * It runs a model and reaches the network, so it is exactly what the replay rule
 * forbids in a body: outside a step it would run again on every resume, and its
 * answer would differ each time. Inside one it is journaled like any other step
 * result — the whole loop, once. Nothing here checks that, for the reason
 * nothing else in `sdk/` does: this module cannot see the run context.
 *
 * ## What a step DOES NOT get
 *
 * A subagent's tools are run with the same executor a tool call uses, so they
 * get argument coercion, validation and the per-call deadline. What they do not
 * get is a session: there is no `ctx.slots`, no `sessionId` and no
 * `ctx.messages` to read, because a workflow run has none of those. A subagent
 * delegated from a step should therefore reach only `builtinTools` and tools
 * whose work is a pure function of their arguments.
 *
 * ## An UNPUBLISHED slot THROWS
 *
 * Unlike {@link stepReport} (best-effort narration, so a lost line is nothing)
 * and {@link stepEnv} (`process.env` is a real answer), there is no degraded
 * version of running a model loop — an empty result would be indistinguishable
 * from a researcher that found nothing, which is the failure this whole
 * mechanism exists to make impossible. A spec driving an exported step reaches
 * for `stubStepDelegate` / `installStubStepDelegate`
 * (`@alexkroman1/aai/testing`, `/testing/vitest`), which is one line and cannot
 * be mistaken for a real run.
 */

import type { DelegateOptions, DelegateResult, SubagentDef } from "./subagent.ts";

/**
 * The registry-wide slot. Prefixed with the package name so a second copy of
 * this SDK in the same process shares it rather than shadowing it — the agent
 * bundle carries its own copy of this module and the host publishes from its
 * own graph, which is the whole reason this is a `Symbol.for`.
 */
const STEP_DELEGATE_SLOT = Symbol.for("@alexkroman1/aai.stepDelegate");

/**
 * What a published runner does: run one subagent to completion.
 *
 * Identical in shape to `DelegateFn`, deliberately — the host fills this slot
 * with `createSubagentRunner` bound to a sessionless parent bag, so the same
 * `SubagentDef` behaves the same way whether a tool or a step reached it.
 *
 * @internal
 */
export type StepDelegateFn = (
  subagent: SubagentDef,
  options: DelegateOptions,
) => Promise<DelegateResult>;

type StepDelegateSlot = { [STEP_DELEGATE_SLOT]?: StepDelegateFn };

/**
 * Publish the runner this process's steps delegate through.
 *
 * Called by whatever is about to serve workflows — `installWorkflowSupport`,
 * beside the reporter, the speech synthesizer and `stepFetch`. Passing
 * `undefined` UNPUBLISHES, which is what a test's `restore` does.
 *
 * @internal
 */
export function publishStepDelegate(runner: StepDelegateFn | undefined): void {
  const slot = globalThis as StepDelegateSlot;
  if (runner === undefined) delete slot[STEP_DELEGATE_SLOT];
  else slot[STEP_DELEGATE_SLOT] = runner;
}

/**
 * Hand a bounded task to a SUBAGENT from inside a step.
 *
 * The step-side `ctx.delegate`: its own instructions, model, tools and context
 * window, and what comes back is {@link DelegateResult} — the final message plus
 * what the run cost, never the tool results that stayed inside it.
 *
 * Rejects when nothing has published a runner (see the module doc), and for
 * everything `ctx.delegate` rejects on: no LLM named, an unknown builtin, a
 * cancelled parent.
 *
 * @public
 */
export function stepDelegate(
  subagent: SubagentDef,
  options: DelegateOptions,
): Promise<DelegateResult> {
  const runner = (globalThis as StepDelegateSlot)[STEP_DELEGATE_SLOT];
  if (!runner) {
    return Promise.reject(
      new Error(
        `stepDelegate("${subagent.name}"): no runner is published in this process. ` +
          "A host publishes one when it serves workflows (`aai dev`, a deployed guest, " +
          "`createAgentServer`), so this is either a step called outside a run — reach " +
          "for `installStubStepDelegate()`, from the `/testing/vitest` subpath — or a " +
          "workflow being served by something that never called `installWorkflowSupport`.",
      ),
    );
  }
  return runner(subagent, options);
}
