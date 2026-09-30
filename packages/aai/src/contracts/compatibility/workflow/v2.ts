// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow` epoch 2.
 *
 * Epoch 3 ADDED `ctx.sayOnClient` to `WorkflowContext` (and its notice type).
 * The probe calls that a break for the reason epoch 2's own example gives for
 * `ctx.poll`: an object built to the OLD shape no longer satisfies the new
 * one, which is only true of code that IMPLEMENTS `WorkflowContext` by hand —
 * and `createWorkflowContext` exists so nobody has to.
 *
 * What epoch 2 promised an author is what this file writes: everything epoch
 * 1's example does, plus `ctx.poll`, `workflow({ onFailure })` in both its
 * forms, `findByKey`/`cancelAll` and `StartOptions.dedupeKey`. All of it still
 * compiles, which is the claim the retain makes. If a later epoch changes one
 * of these CALLS, this file reddens — the signal to drop the epoch, never to
 * edit the example.
 *
 * Relative specifiers, so this proves epoch 2's names against the current
 * SOURCE rather than whatever the package's `exports` map resolves to.
 *
 * @module
 */

import type {
  PollOptions,
  PollResult,
  SleepOptions,
  StepOptions,
  StepSchemaOptions,
  WaitForOptions,
  WaitForSchemaOptions,
  WorkflowClient,
  WorkflowContext,
  WorkflowDef,
  WorkflowFailureContext,
  WorkflowFailureHandler,
  WorkflowFailureHook,
} from "../../../index.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS, workflow } from "../../../index.ts";
import type { StandardSchemaV1 } from "../../../sdk/standard-schema.ts";

declare function fetchArticle(url: string): Promise<string>;
declare function transcriptReady(id: string): Promise<boolean>;
declare function announce(runId: string, url: string, why: string): Promise<void>;
declare const approval: StandardSchemaV1<unknown, { approved: boolean }>;
declare const headline: StandardSchemaV1<unknown, string>;

const retry: StepOptions = { maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS + 2 };
const checked: StepSchemaOptions<typeof headline> = { schema: headline };
const nap: SleepOptions = { correlationId: "review" };
const bounded: WaitForOptions<typeof approval> & WaitForSchemaOptions<typeof approval> = {
  schema: approval,
  timeoutMs: 60_000,
};
const unbounded: WaitForSchemaOptions<typeof approval> = { schema: approval };
const polling: PollOptions<boolean> = { everyMs: 10_000, maxMs: 600_000, done: (ready) => ready };

export async function digestFlow(
  input: { url: string },
  ctx: WorkflowContext,
): Promise<{ headline: string; approved: boolean; ready: boolean }> {
  const text = await ctx.step("fetch", () => fetchArticle(input.url), retry);
  const title = await ctx.step("title", () => text.slice(0, 80), checked);
  const polled: PollResult<boolean> = await ctx.poll(
    "ready",
    () => transcriptReady(input.url),
    polling,
  );
  await ctx.sleep("review-window", 6 * 60 * 60 * 1000, nap);
  const answer = await ctx.waitFor(`digest:${input.url}`, bounded);
  const confirmed = await ctx.waitFor(`digest-confirm:${input.url}`, unbounded);
  const startedAt = await ctx.now();
  void [startedAt, await ctx.random(), await ctx.uuid(), ctx.runId, ctx.workflow];
  return {
    headline: title,
    approved: (answer?.approved ?? false) && confirmed.approved,
    ready: polled.done && polled.value,
  };
}

const onFailureHook: WorkflowFailureHook<{ url: string }> = async (
  err: Error,
  context: WorkflowFailureContext<{ url: string }>,
) => {
  await announce(context.runId, context.input.url, err.message);
};
const onFailure: WorkflowFailureHandler<{ url: string }> = {
  run: onFailureHook,
  maxAttempts: 5,
};

export const digest: WorkflowDef<StandardSchemaV1<unknown, { url: string }>, unknown> = workflow({
  description: "Summarize a link",
  run: digestFlow,
  onFailure,
});

export const bare: WorkflowDef<StandardSchemaV1<unknown, { url: string }>, unknown> = workflow({
  run: digestFlow,
  onFailure: onFailureHook,
});

export async function startAndRead(workflows: WorkflowClient, url: string): Promise<number> {
  const runId = await workflows.start(
    "digest",
    { url },
    { key: "caller-1", label: url, dedupeKey: url },
  );
  const run = await workflows.get(runId);
  const mine = await workflows.find("digest", "caller-1", { limit: 5 });
  const everywhere = await workflows.findByKey("caller-1");
  const recent = await workflows.recent("digest");
  await workflows.cancel(runId);
  const cancelled = await workflows.cancelAll("digest", "caller-1");
  await workflows.wakeUp(runId, { correlationIds: ["review"] });
  await workflows.signal(`digest:${url}`, { approved: true });
  await workflows.streamTail(runId);
  await workflows.lastLine(runId);
  await workflows.stream(runId, { startIndex: 0 });
  void [run?.status, workflows.publicWebhookUrl("t"), workflows.listing()];
  return mine.length + everywhere.length + recent.length + cancelled;
}
