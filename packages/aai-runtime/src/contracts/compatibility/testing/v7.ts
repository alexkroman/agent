// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:testing` epoch 7.
 *
 * Driving an agent's own machinery from a spec, written the way it was authored
 * at epoch 7 — a DURABLE workflow run over the real engine, and a TEXT agent
 * turn over a scripted model. It must keep compiling for as long as that epoch
 * is advertised as supported.
 *
 * ## What moved, and why epoch 7 survives it
 *
 * Epoch 8 added ten names and removed none: `JournalStore` and the six records
 * it is a dozen methods over (`RunRecord`, `StepEntry`, `SleepRecord`,
 * `SleepEntry`, `HookRecord`, `ResumableRun`), plus `RunStatus`,
 * `JournalConflictError` and `DeterminismKind`.
 *
 * Every one was already REACHABLE at epoch 7 and nameable from nowhere.
 * `RunWorkflowOptions.journal` took a store, so a spec could pass one and could
 * not declare it; `getRun` answered a `RunRecord` no `import type` named; and
 * `claimHook` documented throwing a `JournalConflictError` a caller could not
 * catch by name. A spec authored at epoch 7 therefore used the memory journal
 * and read the handle's own projections, which is exactly what this file does —
 * and which is unaffected by publishing names it never spelled. That is what
 * makes this a retain rather than a drop.
 *
 * ## What a `runWorkflow` test is NOT
 *
 * The engine is real, but the SUSPENSIONS are driven by the handle rather than
 * by a clock: `advanceSleep` wakes a durable sleep without waiting it out. That
 * is the point — a spec must not sit through a day-long schedule — and it is
 * also the limit: nothing here exercises the platform's queue, its delivery
 * ceiling, or two concurrent walks of one run.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 7 has to be dropped with a reason.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import {
  DEFAULT_MAX_DELIVERIES,
  type RunTextAgentOptions,
  type RunWorkflowOptions,
  runTextAgent,
  runWorkflow,
  type ScriptedTextStep,
  type ScriptedToolCall,
  scriptedTextModel,
  type TextAgentTestRun,
  type TextAgentTestToolCall,
  type WorkflowTestHandle,
  type WorkflowTestStep,
} from "../../../testing-barrel.ts";

/**
 * ── EDIT: the workflow under test. ──────────────────────────────────────
 */
const review = workflow({
  description: "Hold a draft until a reviewer answers",
  input: z.object({ draft: z.string().min(1).describe("What to review") }),
  run: async (input, ctx) => {
    const prepared = await ctx.step("prepare", async () => `draft: ${input.draft}`);
    // A durable wait, so the run SUSPENDS here. `signal` below is how a spec
    // crosses it without a reviewer.
    await ctx.waitFor<{ approved: boolean }>("approval");
    return await ctx.step("publish", async () => `published ${prepared}`);
  },
});

/**
 * ── EDIT: how this project drives a run. ────────────────────────────────
 *
 * `name` is what the run is recorded under, so it has to match what the app
 * declares. `maxDeliveries` bounds how many times the harness walks the run
 * before giving up, which turns a body that never settles into a failed spec
 * rather than a hung one.
 */
const RUN_OPTIONS: RunWorkflowOptions = {
  name: "review",
  maxDeliveries: DEFAULT_MAX_DELIVERIES,
};

/** The suspended shape, asserted on its own: every step before the wait is journaled. */
export async function untilApproval(draft: string): Promise<WorkflowTestHandle<unknown>> {
  const run = await runWorkflow(review, { draft }, RUN_OPTIONS);
  if (run.status !== "running") throw new Error(`expected a parked run, got ${run.status}`);
  return run;
}

/**
 * ── EDIT: the resume, and the claim that matters about it. ──────────────
 *
 * The assertion worth making is that the resumed walk ANSWERS `prepare` from
 * the journal instead of running it again — the whole promise of durable
 * execution — which the step keys make readable off the handle.
 */
export async function keysAfterApproval(draft: string): Promise<readonly WorkflowTestStep[]> {
  const run = await untilApproval(draft);
  try {
    await run.signal("approval", { approved: true });
    if (run.status !== "completed") throw new Error(`expected completed, got ${run.status}`);
    return run.steps;
  } finally {
    // The journal and its timers are the handle's; a spec that leaks one leaks
    // it into the next file.
    await run.close();
  }
}

/**
 * ── EDIT: the TEXT half. ────────────────────────────────────────────────
 *
 * `scriptedTextModel` is the provider socket and nothing else: the agent
 * underneath is the real one, so tool discovery, argument coercion and the
 * per-call deadline are all in the path. A step says what the model SAYS and
 * what it CALLS, which is what makes a tool-discipline assertion deterministic.
 */
const support = agent({
  name: "Support",
  systemPrompt: "Look orders up before answering.",
  // `runTextAgent` refuses a voice agent by name — a text agent fills no
  // pipeline stages, so there is nothing for a scripted model to stand between.
  text: true,
});

/**
 * ── EDIT: the calls this script makes the model issue. ──────────────────
 *
 * `input` is the arguments as an OBJECT — serialized to the JSON string the
 * wire carries, so a spec writes what it means and the real coercion, Standard
 * Schema validation and repair path all still run on the way in. That is the
 * point of scripting a MODEL rather than calling `execute` directly.
 */
const LOOKUP: ScriptedToolCall = { name: "look_up", input: { order: "W1234" } };

const SCRIPT: readonly ScriptedTextStep[] = [
  { toolCalls: [LOOKUP] },
  { text: "Order W1234 shipped yesterday." },
];

const TEXT_OPTIONS: RunTextAgentOptions = {
  // `script` rather than a model: the harness builds the model, so a run with
  // no script cannot be written by accident.
  script: SCRIPT,
};

export async function answerFor(message: string): Promise<TextAgentTestRun> {
  return await runTextAgent(support, message, TEXT_OPTIONS);
}

/**
 * ── EDIT: what a spec asserts about the calls that happened. ────────────
 *
 * The run reports the calls it made, each carrying its id, so two calls of one
 * tool stay distinguishable without naming an id in the script.
 */
export function calledNames(run: TextAgentTestRun): readonly string[] {
  return run.toolCalls.map((call: TextAgentTestToolCall) => call.name);
}

/**
 * ── EDIT: handing the scripted model somewhere else. ────────────────────
 *
 * `runTextAgent` builds the model from `script` itself, which is what a spec
 * wants. `scriptedTextModel` is the same model as a VALUE, for anything else
 * that takes a resolved `LanguageModel` — a `createTextAgent` a host wires up
 * on its own, or a subagent under evaluation.
 */
export function modelFor(script: readonly ScriptedTextStep[] = SCRIPT) {
  return scriptedTextModel(script);
}
