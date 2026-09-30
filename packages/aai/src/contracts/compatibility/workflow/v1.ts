// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow` epoch 1.
 *
 * Epoch 2 ADDED three members to types an author is HANDED: `ctx.poll` on
 * `WorkflowContext`, `findByKey` and `cancelAll` on `WorkflowClient` (plus the
 * optional `onFailure` on `WorkflowDef` and `dedupeKey` on `StartOptions`). The
 * probe calls that a break because an object built to the OLD shape no longer
 * satisfies the new one — which is only true of code that IMPLEMENTS those
 * types by hand, and the SDK ships `createStubWorkflows` and
 * `createWorkflowContext` so nobody has to.
 *
 * What epoch 1 promised an author is what this file writes: declare a workflow
 * with `workflow()`, write a body against `WorkflowContext` (steps with options
 * and schemas, sleeps, hooks with and without a deadline), and start and read
 * runs through `ctx.workflows`. All of it still compiles, which is the claim
 * the retain makes. If a later epoch changes one of these CALLS, this file
 * reddens — the signal to drop the epoch, never to edit the example.
 *
 * Relative specifiers, so this proves epoch 1's names against the current
 * SOURCE rather than whatever the package's `exports` map resolves to.
 *
 * @module
 */

import type {
  SleepOptions,
  StepOptions,
  StepSchemaOptions,
  WaitForOptions,
  WaitForSchemaOptions,
  WorkflowClient,
  WorkflowContext,
  WorkflowDef,
} from "../../../index.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS, workflow } from "../../../index.ts";
import type { StandardSchemaV1 } from "../../../sdk/standard-schema.ts";

declare function fetchArticle(url: string): Promise<string>;
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

export async function digestFlow(
  input: { url: string },
  ctx: WorkflowContext,
): Promise<{ headline: string; approved: boolean }> {
  const text = await ctx.step("fetch", () => fetchArticle(input.url), retry);
  const title = await ctx.step("title", () => text.slice(0, 80), checked);
  await ctx.sleep("review-window", 6 * 60 * 60 * 1000, nap);
  const answer = await ctx.waitFor(`digest:${input.url}`, bounded);
  const confirmed = await ctx.waitFor(`digest-confirm:${input.url}`, unbounded);
  const startedAt = await ctx.now();
  void [startedAt, await ctx.random(), await ctx.uuid(), ctx.runId, ctx.workflow];
  return { headline: title, approved: (answer?.approved ?? false) && confirmed.approved };
}

export const digest: WorkflowDef<StandardSchemaV1<unknown, { url: string }>, unknown> = workflow({
  description: "Summarize a link",
  run: digestFlow,
});

export async function startAndRead(workflows: WorkflowClient, url: string): Promise<number> {
  const runId = await workflows.start("digest", { url }, { key: "caller-1", label: url });
  const run = await workflows.get(runId);
  const mine = await workflows.find("digest", "caller-1", { limit: 5 });
  const recent = await workflows.recent("digest");
  await workflows.cancel(runId);
  await workflows.wakeUp(runId, { correlationIds: ["review"] });
  await workflows.signal(`digest:${url}`, { approved: true });
  await workflows.streamTail(runId);
  await workflows.lastLine(runId);
  await workflows.stream(runId, { startIndex: 0 });
  void [run?.status, workflows.publicWebhookUrl("t"), workflows.listing()];
  return mine.length + recent.length;
}
