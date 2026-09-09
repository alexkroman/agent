// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:testing` epoch 1.
 *
 * Driving an agent's own machinery from a spec, written the way it was authored
 * at epoch 1 — a DURABLE workflow run over the real engine, and a TEXT agent
 * turn over a scripted model. It must keep compiling for as long as that epoch
 * is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Nothing a spec writes. `RunTextAgentOptions` is `TextAgentOptions` minus the
 * two fields the harness supplies, so that type is INLINED into this
 * capability's rollup — the coupling the entrypoint's own doc calls the honest
 * one. `text-agent.ts` then reached the 500-line source cap and was SPLIT, its
 * caller-facing declarations moving to `text-agent-types.ts` and its message
 * assembly to `text-agent-messages.ts`, with everything re-exported. Every
 * declaration is byte-identical; what changed is the rollup's PROVENANCE, since
 * the new module reaches the AI SDK through `import type`. A form change in the
 * report with no signature behind it is the whole of the transition, and it is
 * why this is a retain rather than a drop.
 *
 * Two additions landed the same day and are deliberately not visible here:
 * `ctx.generate` reporting usage (`onUsage`, on a bag this report does not
 * carry) and per-tool error classification (`FatalToolError` and friends, which
 * are internal to the executor and published by no subpath). A spec that
 * scripts a model sees neither.
 *
 * The direction that WOULD break is a field arriving on `TextAgentOptions` that
 * `runTextAgent` does NOT supply and a spec must — the subtraction is what
 * keeps a new capability reachable from a spec on the day it lands, and it
 * cuts both ways.
 *
 * ## What a `runWorkflow` test is NOT
 *
 * The engine is real, but the SUSPENSIONS are driven by the handle rather than
 * by a clock: `advanceSleep` wakes a durable sleep without waiting it out, and
 * `signal` delivers a hook. That is the point — a spec must not sit through a
 * day-long schedule — and it is also the limit: nothing here exercises the
 * platform's queue, its delivery ceiling, or two concurrent walks of one run.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 *
 * @module
 */

import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import {
  DEFAULT_MAX_DELIVERIES,
  type DeterminismKind,
  type HookRecord,
  JournalConflictError,
  type JournalStore,
  type ResumableRun,
  type RunRecord,
  type RunStatus,
  type RunTextAgentOptions,
  type RunWorkflowOptions,
  runTextAgent,
  runWorkflow,
  type ScriptedTextStep,
  type ScriptedToolCall,
  type SleepEntry,
  type SleepRecord,
  type StepEntry,
  scriptedTextModel,
  type TextAgentTestRun,
  type TextAgentTestToolCall,
  type WorkflowTestHandle,
  type WorkflowTestRead,
  type WorkflowTestRun,
  type WorkflowTestStep,
} from "../../../testing-barrel.ts";

// ─── The DURABLE half ────────────────────────────────────────────────────────

/** ── EDIT: the workflow under test. ────────────────────────────────────── */
const digest = workflow({
  description: "Gather notes on a topic, settle overnight, then write the report",
  input: z.object({ topic: z.string().min(3).describe("What to digest") }),
  // `(input, ctx)` — the INPUT first, which is the order a body is called with.
  run: async (input, ctx) => {
    const found = await ctx.step("gather", async () => `notes about ${input.topic}`);
    // A durable wait, so the run SUSPENDS here rather than blocking. Nothing is
    // holding a sandbox open across it, which is the whole reason a caller can
    // hang up — and `advanceSleep` below is how a spec crosses it.
    await ctx.sleep("settle", 60 * 60 * 1000);
    return await ctx.step("write", async () => `report: ${found}`);
  },
});

/**
 * ── EDIT: how this project drives a run. ────────────────────────────────
 *
 * `name` is what the run is recorded under, so it has to match what the app
 * declares or a page reading the run back finds nothing. `maxDeliveries` bounds
 * how many times the harness walks the run before giving up, which turns a body
 * that never settles into a failed spec rather than a hung one;
 * {@link DEFAULT_MAX_DELIVERIES} is the default and generous.
 */
const RUN_OPTIONS: RunWorkflowOptions = {
  name: "digest",
  maxDeliveries: DEFAULT_MAX_DELIVERIES,
};

/**
 * ── EDIT: what "the run got as far as the wait" means for you. ──────────
 *
 * The suspended shape is worth asserting on its own: every step before the wait
 * is already journaled, so a resume must not run them again. `wakeAt` is what
 * says the run is waiting rather than finished.
 */
export async function untilWait(topic: string): Promise<WorkflowTestHandle<string>> {
  const run = await runWorkflow(digest, { topic }, RUN_OPTIONS);
  if (run.status !== "running" || run.wakeAt === undefined) {
    throw new Error(`expected a suspended run, got ${run.status}`);
  }
  return run;
}

/**
 * ── EDIT: what your spec wants to read off a finished run. ──────────────
 *
 * The handle IS a {@link WorkflowTestRun}, so everything a spec asserts on is a
 * property rather than a second call: the steps it journaled, the
 * non-deterministic values it read ({@link WorkflowTestRead} — one per
 * `ctx.now()`, `ctx.random()` or `ctx.uuid()`, which is what makes a replay
 * comparable), and how many deliveries it took.
 */
export type DigestReport = {
  readonly steps: readonly WorkflowTestStep[];
  readonly reads: readonly WorkflowTestRead[];
  readonly kinds: readonly DeterminismKind[];
  readonly deliveries: number;
};

export function reportOf(run: WorkflowTestRun<string>): DigestReport {
  return {
    steps: run.steps,
    reads: run.reads,
    kinds: run.reads.map((read) => read.kind),
    deliveries: run.deliveries,
  };
}

/**
 * ── EDIT: the resume, and the claim that matters about it. ──────────────
 *
 * `advanceSleep` is `ctx.workflows.wakeUp`'s own mechanism, so this is the
 * production wake path rather than a test-only shortcut. What the assertion is
 * for is that the resumed walk ANSWERS `gather` from the journal instead of
 * running it a second time — the whole promise of durable execution.
 */
export async function keysAfterResume(topic: string): Promise<readonly string[]> {
  const run = await untilWait(topic);
  try {
    await run.advanceSleep();
    if (run.status !== "completed") throw new Error(`expected completed, got ${run.status}`);
    return run.steps.map((step) => step.key);
  } finally {
    // The journal and its timers are the handle's; a spec that leaks one leaks
    // it into the next file.
    await run.close();
  }
}

/**
 * ── EDIT: reading the JOURNAL itself, for a spec the handle cannot serve. ─
 *
 * `RunWorkflowOptions.journal` invites a store of your own — the point being
 * that a deployment which already owns a database can drive a spec against it —
 * so the records that store is a dozen methods over are published too. Without
 * them `getRun` answered a shape no `import type` could name.
 *
 * A store the ENGINE hands back is the read-only case, which is this one.
 */
export type JournalView = {
  readonly record: RunRecord | undefined;
  readonly status: RunStatus;
  readonly steps: readonly StepEntry[];
  readonly sleeps: readonly SleepEntry[];
};

export async function journalOf(run: WorkflowTestHandle<string>): Promise<JournalView> {
  const journal: JournalStore = run.journal;
  const record = await journal.getRun(run.runId);
  const steps = await journal.readSteps(run.runId);
  const sleeps = await journal.readSleeps(run.runId);
  return { record, status: record?.status ?? "pending", steps, sleeps };
}

/**
 * ── EDIT: the two journal calls a spec makes on PURPOSE. ────────────────
 *
 * Claiming a sleep and claiming a hook are the engine's own moves, and a spec
 * reaches for them when it is testing the STORE rather than the workflow — a
 * Postgres-backed implementation of the same interface, driven through the
 * shapes the memory one is checked against. {@link JournalConflictError} is
 * what a second claimant gets, and catching it by name is the whole reason the
 * class is exported rather than the message being matched.
 */
export async function claimTwice(
  journal: JournalStore,
  runId: string,
): Promise<{ readonly sleep: SleepRecord; readonly hook: HookRecord; readonly raced: boolean }> {
  const sleep = await journal.claimSleep(runId, "settle", Date.now() + 1000, undefined, "sleep");
  const hook = await journal.claimHook(runId, "approval", "token-1");
  try {
    await journal.claimHook(runId, "approval", "token-2");
    return { sleep, hook, raced: false };
  } catch (error) {
    if (!JournalConflictError.is(error)) throw error;
    return { sleep, hook, raced: true };
  }
}

/**
 * What a queue worker asks a store at boot: which runs are still owed a walk.
 *
 * OPTIONAL on the interface — a memory journal answers nothing — so a caller
 * that wants it has to ask for it the way a caller must.
 */
export async function resumable(journal: JournalStore): Promise<readonly ResumableRun[]> {
  return (await journal.resumableRuns?.(10)) ?? [];
}

// ─── The TEXT half ───────────────────────────────────────────────────────────

/**
 * ── EDIT: the agent under test. ─────────────────────────────────────────
 *
 * `scriptedTextModel` is the provider socket and nothing else: the agent
 * underneath is the real one, so tool discovery, argument coercion and the
 * per-call deadline are all in the path.
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
  // Everything else here is `TextAgentOptions` minus what the harness supplies,
  // so a capability added to a text agent is reachable from a spec the day it
  // lands rather than having to be restated.
  env: {},
  maxSteps: 4,
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
