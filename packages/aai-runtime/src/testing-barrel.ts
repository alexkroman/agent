// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/testing` — driving an agent's own machinery from a
 * spec: a DURABLE workflow run, and a TEXT agent turn.
 *
 * The one thing an agent author could not test. A workflow's steps are ordinary
 * exported functions and its declaration is a value, so both have always been
 * reachable from a vitest file; the BODY takes a `ctx` only an engine
 * constructs. `@alexkroman1/aai/testing`'s `createWorkflowContext` gives it one that
 * records — which is the right tool for asserting what a body ASKED FOR, and
 * says outright that it is not a durability test — and this gives it the real
 * engine, over the memory journal, so a spec can assert that a run slept,
 * resumed, retried, was answered, and survived a dead worker.
 *
 * ```ts
 * import { workflow } from "@alexkroman1/aai";
 * import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
 *
 * const approve = workflow({
 *   description: "Hold a draft until a reviewer answers.",
 *   run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval:1"),
 * });
 *
 * const run = await runWorkflow(approve, { draft: "…" }, { name: "approve" });
 * console.log(run.status); // "running" — parked on the reviewer
 *
 * await run.signal("approval:1", { approved: true });
 * console.log(run.status); // "completed"
 * ```
 *
 * ## The TEXT half
 *
 * `scriptedTextModel` and `runTextAgent` are the same idea one mode over.
 * `createTextAgent` takes a pre-resolved `LanguageModel` and says outright that
 * tests are the majority use of that field, and there was nothing published to
 * put in it — so every caller wrote the provider shape out by hand and cast it,
 * and each copy re-derived the `finish` frame's shape (the one whose bare-string
 * spelling silently stops every tool from running). The script is a step —
 * what the model says, what it calls — and the agent underneath is the real one.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { runTextAgent } from "@alexkroman1/aai-runtime/testing";
 *
 * const run = await runTextAgent(
 *   agent({ name: "Desk", text: true, systemPrompt: "Be brief." }),
 *   "where is order 7?",
 *   { script: [{ text: "It shipped yesterday." }] },
 * );
 * console.log(run.text); // "It shipped yesterday."
 * ```
 *
 * ## Why it is on the RUNTIME rather than beside `createWorkflowContext`
 *
 * `@alexkroman1/aai` is the shared core and imports no sibling package — a hard
 * boundary this repo checks with `konsistent`, and one the engine sits on the
 * far side of. The engine, the journal and `createInProcessWorkflowEngine` are
 * `@alexkroman1/aai-runtime`'s, so a helper that runs a real one has to live
 * here. The split a template sees is therefore: `@alexkroman1/aai/testing` for
 * the CONTEXT (no journal, one walk, everything recorded), this for the ENGINE
 * (a journal, real replays, real suspensions).
 *
 * ## Runner-agnostic, deliberately
 *
 * Nothing here installs a global or owns a lifetime a runner has to unwind —
 * the driver injects its own dispatcher, so no timer is ever armed — which is
 * this repo's rule for what may stay off a `/vitest` subpath. It works from any
 * harness.
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public API
 * until it is added here.
 *
 * @module testing
 */

export {
  type RunTextAgentOptions,
  runTextAgent,
  type TextAgentTestRun,
  type TextAgentTestToolCall,
} from "./testing/run-text-agent.ts";
export {
  DEFAULT_MAX_DELIVERIES,
  runWorkflow,
} from "./testing/run-workflow.ts";
export type {
  RunWorkflowOptions,
  WorkflowTestHandle,
  WorkflowTestRead,
  WorkflowTestRun,
  WorkflowTestStep,
} from "./testing/run-workflow-types.ts";
export {
  type ScriptedTextStep,
  type ScriptedToolCall,
  scriptedTextModel,
} from "./testing/scripted-text-model.ts";
// `RunTextAgentOptions` extends the per-turn options with them, and this
// subpath published neither the extension nor the thing extended. Same
// declaration `@alexkroman1/aai-runtime` exports, re-exported so a spec that
// builds turn options up in a helper can name what it is building.
export type { TextAgentOptions, TextTurnOptions } from "./text-agent.ts";
// The six records a journal holds. `JournalStore` is a dozen methods over
// exactly these, so publishing the store and not the records published a shape
// nobody could read: `getRun` answered a `RunRecord` no `import type` named.
// They are also what a spec asserting on a real run inspects directly.
export type {
  HookRecord,
  ResumableRun,
  RunRecord,
  SleepEntry,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-records.ts";
// The two types those name and this subpath did not publish. `journal` is the
// documented seam for running a spec against a real store rather than the
// memory one, which is unusable if the store's shape has no name here; and
// `WorkflowTestRead.kind` is what a determinism assertion switches on.
// `JournalConflictError` is a VALUE, and it is on this subpath for the same
// reason `JournalStore` is: `runWorkflow`'s `journal` option invites a store of
// your own, and `claimHook` documents throwing this to signal a duplicate wait
// token. A contract a caller must satisfy and cannot name is not a contract.
export {
  JournalConflictError,
  type JournalStore,
  type RunStatus,
} from "./workflow-journal-types.ts";
export type { DeterminismKind } from "./workflow-replay-determinism.ts";
