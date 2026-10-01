// Copyright 2026 the AAI authors. MIT license.
/**
 * Fixtures for the two workflow shapes a tool's spec has to build by hand: a
 * run snapshot, and the progress stream `WorkflowClient.stream` answers with.
 *
 * Both existed in two templates apiece, and the snapshot builder is the one
 * that matters: `WorkflowRunSnapshot` is DISCRIMINATED on `status`, so
 * `{ ...base, ...overrides }` does not inhabit it and every hand-rolled version ended
 * in `as WorkflowRunSnapshot`. That cast is the exact failure
 * {@link createToolContext} and {@link createStubWorkflows} exist to remove: it
 * keeps compiling when the union gains a member or a member gains a field, so
 * the fixture silently stops resembling what a tool will actually be handed.
 */

import { omitUndefined } from "./omit-undefined.ts";
import type { WorkflowClient } from "./workflow.ts";
import type { WorkflowRunBase, WorkflowRunSnapshot } from "./workflow-run.ts";
import { rejectingWorkflows } from "./workflow-unavailable.ts";

/**
 * What {@link createRunSnapshot} accepts: the shared fields, plus whatever the
 * chosen status requires.
 *
 * The `status`-bearing half mirrors {@link WorkflowRunSnapshot}'s own union, so
 * asking for `status: "completed"` without an `output` is a compile error rather
 * than a fixture that lies.
 *
 * @typeParam R - The workflow's return type, when the caller names it.
 *
 * @public
 */
export type RunSnapshotOverrides<R = unknown> = Partial<WorkflowRunBase> &
  (
    | { status?: "pending" | "running" | undefined }
    | { status: "completed"; output: R }
    | { status: "failed"; error: string }
    | { status: "cancelled" }
  );

/** Defaults, so a spec names only the field its assertion is about. */
const DEFAULT_RUN_ID = "wrun_1";
const DEFAULT_WORKFLOW = "workflow";
/** A fixed instant — a fixture that read the clock would not replay. */
const DEFAULT_CREATED_AT = Date.UTC(2026, 0, 1);

/**
 * Build a {@link WorkflowRunSnapshot} — the right arm of the union, without a
 * cast.
 *
 * Defaults to a `running` run, which is the state a tool that has just started
 * one reads back.
 *
 * @example
 * ```ts
 * import { createRunSnapshot, createStubWorkflows } from "@alexkroman1/aai/testing";
 *
 * const workflows = createStubWorkflows({
 *   find: () => Promise.resolve([createRunSnapshot({ status: "failed", error: "gateway down" })]),
 * });
 * ```
 *
 * @public
 */
export function createRunSnapshot<R = unknown>(
  overrides: RunSnapshotOverrides<R> = {},
): WorkflowRunSnapshot<R> {
  const base: WorkflowRunBase = {
    runId: overrides.runId ?? DEFAULT_RUN_ID,
    workflow: overrides.workflow ?? DEFAULT_WORKFLOW,
    createdAt: overrides.createdAt ?? DEFAULT_CREATED_AT,
    ...omitUndefined({ key: overrides.key }),
  };
  if (!("status" in overrides) || overrides.status === undefined)
    return { ...base, status: "running" };
  switch (overrides.status) {
    case "completed":
      return { ...base, status: "completed", output: overrides.output };
    case "failed":
      return { ...base, status: "failed", error: overrides.error };
    case "cancelled":
      return { ...base, status: "cancelled" };
    default:
      return { ...base, status: overrides.status };
  }
}

/**
 * The progress channel of a run, from the read side — what
 * `ctx.workflows.stream` resolves with.
 *
 * Closes after the given lines, which is what makes a tool that drains it
 * terminate. A run's real stream never closes (no step knows it is the last
 * one), and the tool bounds itself with `streamTail` instead — so a spec that
 * wants to exercise THAT bound stubs `streamTail`, not this.
 *
 * @example
 * ```ts
 * import { createProgressStream, createStubWorkflows } from "@alexkroman1/aai/testing";
 *
 * const workflows = createStubWorkflows({
 *   streamTail: () => Promise.resolve(0),
 *   stream: () => Promise.resolve(createProgressStream(["Reading the sources…"])),
 * });
 * ```
 *
 * @public
 */
export function createProgressStream(lines: readonly unknown[] = []): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const line of lines) controller.enqueue(line);
      controller.close();
    },
  });
}

/**
 * A `ctx.workflows` for testing a tool that starts or reads durable runs: every
 * method rejects by default, and `overrides` replaces the ones the test drives.
 *
 * **The alternative is a cast, and the cast is what goes wrong.** A complete
 * `WorkflowClient` is eight methods, of which a tool's test usually drives one or
 * two, so the hand-rolled version is a literal with `as WorkflowClient` — which
 * keeps compiling when the client GAINS a method and leaves that method
 * `undefined`. Two shipped templates had exactly that, and adding `wakeUp` and
 * `stream` to the client is what surfaced it: the casts still compiled.
 *
 * Rejecting rather than no-op defaults, for the reason `createUnusedDb` rejected
 * before it went away with `ctx.db` — a tool that reaches for a method the test
 * did not stub should say so, not silently receive `undefined`. `listing` is the exception and returns `[]`,
 * because it is synchronous and an empty list is a truthful answer.
 *
 * ```ts
 * import { createStubWorkflows, createToolContext } from "@alexkroman1/aai/testing";
 *
 * const workflows = createStubWorkflows({ start: async () => "wrun_1" });
 * const ctx = createToolContext({ workflows });
 * ```
 *
 * @public
 */
export function createStubWorkflows(overrides: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    ...rejectingWorkflows(
      "This ctx.workflows method was not stubbed for this test — pass it in the " +
        "overrides handed to createStubWorkflows",
    ),
    ...overrides,
  };
}
