// Copyright 2026 the AAI authors. MIT license.
/**
 * What the eval workflow engine TAKES and what it RECORDS, as types.
 *
 * Split from `workflow-engine.ts` when that file crossed the 500-line cap, along
 * the seam a reader already uses and the one `sdk/dialog-types.ts` and
 * `sdk/session-slot-types.ts` are cut on: what a caller passes IN and gets back,
 * versus the factory that runs it. The factory re-exports every name here, so
 * nothing importing them moved.
 *
 * @module
 */

import type { SpeechSynthesizer, StepFetch } from "@alexkroman1/aai/host-internal";
import type { WorkflowContext, WorkflowDef, WorkflowRunStatus } from "@alexkroman1/aai/workflow-api";
import type { WdkAdapter } from "../workflow-wdk-types.ts";

/** One chunk `stepEmit()` wrote during a run, and the stream it named. */
export type EvalEmitted = {
  /** The stream the step named. */
  readonly namespace: string;
  /** The value, exactly as the step passed it. */
  readonly chunk: unknown;
};

/**
 * One durable `sleep()` a body asked for — and did NOT take.
 *
 * Recorded rather than waited out, because a suspension is the thing this engine
 * cannot reproduce and a real wait would only make a case slow while proving
 * nothing extra: `link-digest`'s ten seconds and the six hours its own comment
 * says the mechanism is identical at differ by nothing that runs here. What a
 * case CAN assert is that the body asked, and for how long.
 */
export type EvalSleep = {
  /**
   * The wait's `label` — its identity in a real run's journal, and here the only
   * thing telling two of a body's waits apart.
   *
   * A case asserting a SCHEDULE wants this: `podcast-digest` sleeps between
   * digests and again while polling, and a duration alone cannot say which of
   * them the body reached.
   */
  readonly label: string;
  /** Exactly what the body passed `sleep()` — `"10 seconds"`, a number of ms, a date. */
  readonly duration: string | number | Date;
};

/** One run this engine executed, as the engine records it. */
export type EvalRunRecord = {
  readonly runId: string;
  /** The key this workflow is declared under in `agent({ workflows })`. */
  readonly workflowName: string;
  status: WorkflowRunStatus;
  readonly createdAt: number;
  output?: unknown;
  error?: { message: string };
  /** Lines this run's steps wrote with `stepReport()`, oldest first. */
  readonly reported: string[];
  /** Chunks this run's steps wrote with `stepEmit()`, oldest first. */
  readonly emitted: EvalEmitted[];
  /** Durable sleeps the body asked for — see {@link EvalSleep}. */
  readonly slept: EvalSleep[];
  /** Wall clock from `start()` to the body settling, once it has. */
  elapsedMs?: number;
  /**
   * Resolves when the body has settled, whatever it did. Never rejects.
   *
   * Writable because it cannot be built with the record: the body needs the
   * record to narrate into, so the promise is assigned the statement after
   * `start` creates one — synchronously, before any caller can read it.
   */
  settled: Promise<void>;
};

/**
 * A workflow body as this engine calls it.
 *
 * `WorkflowDef`'s default schema parameter makes `run` take
 * `Record<string, unknown>` — the validated input — so this is that signature
 * named, and it is what lets the engine call a body without a cast.
 */
export type EvalBody = (
  input: Record<string, unknown>,
  ctx: WorkflowContext,
) => Promise<unknown> | unknown;

/** What {@link createEvalWorkflowEngine} takes. */
export type EvalWorkflowEngineOptions = {
  /** The agent's declared workflows, keyed as `agent({ workflows })` keys them. */
  readonly workflows: Readonly<Record<string, WorkflowDef>>;
  /**
   * The agent env a step reads with `stepEnv`/`requireStepEnv`.
   *
   * Published rather than left to `process.env`, which is what an unpublished
   * slot falls back to: publishing is what makes a step read exactly the keys the
   * agent declares, in an eval as in a deployment.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * A `stepFetch` to publish for this app's steps. Nothing is published by
   * default, which means a step's HTTP falls back to `globalThis.fetch`.
   *
   * **Taken as a VALUE rather than built here, and that is a graph decision
   * rather than a style one.** `createStepFetch` reaches `undici`, and naming it
   * from this module put the runtime's whole step graph into the program of
   * every package whose eval file imports `/eval/vitest` — which is
   * `aai-templates`, where it failed on an unrelated `BodyInit` mismatch under
   * `exactOptionalPropertyTypes`. That is the hazard
   * `packages/aai-runtime/CLAUDE.md` records for `host-internal`, arriving by a
   * new route. A host that wants the pooled HTTP/1.1 fetch passes its own; a
   * template eval does not need one.
   *
   * The cost, stated: `globalThis.fetch` offers `h2` in ALPN, so a WIDE live
   * fan-out through it can collect stream resets a pooled HTTP/1.1 fetch would
   * not (`sdk/step-fetch.ts` has the measurements). An eval is not where a
   * fan-out's concurrency is measured, and the upside is that BOTH published
   * fakes work — `installStubGateway` over the global, and
   * `installStubStepFetch` / `installStubTranscribe` over the slot.
   */
  readonly stepFetch?: StepFetch | undefined;
  /**
   * A speech synthesizer to publish, for a flow whose step calls `stepSpeak`.
   *
   * Nothing by default, so an unpublished slot fails by name — which is the
   * SDK's own behaviour and the right one: there is no global synthesizer to
   * fall back to. A case supplies `installStubSpeech`
   * (`@alexkroman1/aai/testing/vitest`); a host wanting the real socket passes
   * `speakOverWebSocket`, which is not named here for the same graph reason as
   * {@link EvalWorkflowEngineOptions.stepFetch}.
   */
  readonly speech?: SpeechSynthesizer | undefined;
};

/** The engine, and the two things a caller does with it. */
export type EvalWorkflowEngine = {
  /** Hand this to `createWorkflowClient` as its `wdk`. */
  readonly adapter: WdkAdapter;
  /** The run this engine executed under `runId`, if it executed one. */
  record(runId: string): EvalRunRecord | undefined;
  /** Every run, oldest first. */
  records(): readonly EvalRunRecord[];
  /**
   * Unpublish the step slots.
   *
   * Never optional: the slots are process-global, so an engine left installed
   * answers the NEXT case's steps — the cross-file leak `stubUploads` carries the
   * same warning about. Never rejects.
   */
  release(): Promise<void>;
};
