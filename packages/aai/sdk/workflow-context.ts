// Copyright 2026 the AAI authors. MIT license.
/**
 * {@link WorkflowContext} — what a workflow's `run` receives.
 *
 * Split out of `workflow.ts` when it reached the 500-line cap. It is the largest
 * single thing in the authoring surface and the most heavily documented, because
 * every field on it carries a durability rule: `step` is at-least-once, `sleep`
 * does not return on the replay that schedules it, `continueAs` never returns, and
 * `blob` exists because bytes may not ride the journal. Re-exported from
 * `workflow.ts`, so no import path changes.
 */

import type { Db } from "./db.ts";
import type { GenerateFn } from "./generate.ts";
import type { StepOptions } from "./workflow-steps.ts";

/**
 * What a workflow's `run` receives — the same capabilities a tool's `execute`
 * gets (`env`, `db`, `generate`), plus the two that make it durable.
 *
 * @public
 */
export type WorkflowContext = {
  /**
   * Environment variables for this app, exactly as `ctx.env` in a tool.
   * Names a workflow depends on belong in `agent({ requiredEnv })` so a
   * missing value fails at deploy time rather than mid-run.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The app's SQL database. Always available inside a workflow: the journal
   * that makes the run durable lives here, so a run cannot exist without it
   * (unlike `ctx.db` in a tool, which throws when storage is off).
   */
  db: Db;
  /** One-shot LLM generation, identical to `ctx.generate` in a tool. */
  generate: GenerateFn;
  /** This run's id — the same value {@link WorkflowClient.start} resolved with. */
  runId: string;
  /**
   * Aborts when the host is shutting down, and when the run is CANCELLED
   * ({@link WorkflowClient.cancel}) while this process is executing it. A long
   * step should pass it to `fetch` so neither a drain nor a cancel waits out
   * the full attempt; a drained run resumes from the last recorded step, so
   * abandoning work here is safe either way.
   */
  signal: AbortSignal;
  /**
   * Run `fn` once per run and journal its result.
   *
   * On replay a completed step does not re-execute — its recorded output is
   * returned instead. `name` identifies the step, and a name reused inside a
   * loop is disambiguated by call order, so
   * `for (const x of xs) await ctx.step("fetch", …)` journals one entry per
   * iteration. What that costs is DETERMINISM: the sequence of `step` calls
   * must not vary between replays of one run, so branch on values that came
   * out of a step (or out of the input), never on `Date.now()` or `Math.random()`
   * read directly in the workflow body. A run whose sequence DID change is
   * reported — the engine logs the journaled steps a replay never re-claimed —
   * but the report arrives after the fact, so the rule is still the author's.
   *
   * Steps are **at-least-once**. A crash between `fn` returning and the
   * journal write means `fn` runs again on resume, so a step with an external
   * side effect wants an idempotency key — pass the `runId` plus the step
   * name to the provider that accepts one.
   *
   * The result must survive the journal's jsonb round trip. That is CHECKED —
   * {@link findUnjournalable} runs on every output before it is journaled, so a
   * step returning a `Date`, `Map`, `Set`, `RegExp`, `bigint`, `symbol` or a
   * method fails the run on its first execution with the property path named,
   * rather than quietly returning something else on the resume. Return the JSON
   * form (an ISO string, an array of entries) and rebuild outside the step;
   * `satisfies Journalable<T>` gets the same check at compile time.
   *
   * @example
   * ```ts
   * import type { WorkflowContext } from "@alexkroman1/aai";
   * declare const ctx: WorkflowContext; // the context a workflow's run receives
   * declare const month: string;
   *
   * const rows = await ctx.step("fetch-invoices", () =>
   *   ctx.db.query("select * from invoices where month = $1", [month]),
   * );
   * ```
   */
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  /**
   * Read bytes a caller uploaded through the workflow API's `/workflows/blobs`
   * route, by the id the run's input named. Resolves `undefined` when the id is
   * unknown or the blob has already been released or swept.
   *
   * This is the counterpart to that upload, and the pair exists because of what
   * a journal is: `step` outputs and the run input are re-read on EVERY replay,
   * so bytes must not travel in them. A page uploads first, starts the run
   * naming the blob, and the run reads it here — so the audio or document is
   * fetched once per step that needs it and never enters the journal.
   *
   * Call it INSIDE a step only when the bytes are what the step works on; the
   * returned value must not itself be returned from the step (see above).
   *
   * `bytes` owns its `ArrayBuffer` exclusively, so it can be handed straight to
   * a `fetch` body, a `Blob` part or a `FormData` entry — no `new
   * Uint8Array(...)` re-copy, which is what a pooled Node `Buffer` would
   * otherwise force on every caller.
   *
   * @example
   * ```ts
   * import type { WorkflowContext } from "@alexkroman1/aai";
   * declare const ctx: WorkflowContext;
   * declare const blobId: string;
   *
   * const text = await ctx.step("transcribe", async () => {
   *   const audio = await ctx.blob(blobId);
   *   if (!audio) throw new Error(`upload ${blobId} is gone`);
   *   return audio.bytes.byteLength; // …send it somewhere, journal the RESULT
   * });
   * ```
   */
  blob(
    blobId: string,
  ): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> } | undefined>;
  /**
   * Delete an uploaded blob now that the run is done with it.
   *
   * Optional housekeeping, not a correctness requirement — every blob is swept
   * on age anyway. Worth doing when the bytes are a user's own recording or
   * document: the sweep's window is sized for a run that sleeps for hours, which
   * is far longer than a finished run has any reason to keep them.
   *
   * Resolves whether anything was deleted, so a replay of the same step (which
   * finds it already gone) is not an error.
   */
  releaseBlob(blobId: string): Promise<boolean>;
  /**
   * Suspend the run for `ms`, durably.
   *
   * Unlike a `setTimeout`, this does not hold a process open: the wake time
   * is journaled, the run is released, and it is picked up again when due —
   * possibly on another sandbox, possibly days later. The call therefore
   * never returns on the replay that schedules it; treat everything after it
   * as running in a later life of the run.
   */
  sleep(ms: number): Promise<void>;
  /**
   * End this run and start a FRESH one of the same workflow with `input`.
   *
   * Continue-as-new. The successor inherits this run's correlation key, so `find`
   * and the `workflow_status` builtin keep answering, and it starts with an EMPTY
   * journal — which is the point. {@link MAX_WORKFLOW_STEPS} is a hard cap sized
   * under the row limit replay reads the journal through, so a loop over a
   * thousand items is not expressible as ONE run at all; splitting it at a
   * checkpoint is.
   *
   * Nothing after this call runs — it throws to unwind the run, exactly as
   * {@link sleep} does. Treat it as a return, and pass forward everything the next
   * run needs as `input`: the successor shares no state and no journal with this
   * one.
   *
   * This run ends `completed` with `{ continuedAs: <new run id> }` as its output,
   * so a caller polling the old id can follow the chain rather than seeing a run
   * that stopped for no visible reason.
   *
   * @example
   * ```ts
   * import { workflow } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const BATCH = 50;
   *
   * export const reindex = workflow({
   *   input: z.object({ from: z.number().default(0) }),
   *   async run({ from }, ctx) {
   *     const page = await ctx.step("page", () => ({ done: from > 500 }));
   *     if (page.done) return { finished: from };
   *     // Same workflow, next window, fresh step budget.
   *     return ctx.continueAs({ from: from + BATCH });
   *   },
   * });
   * ```
   */
  continueAs(input: unknown): never;
};
