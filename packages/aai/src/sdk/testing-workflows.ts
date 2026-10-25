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

import { isWorkflowDef } from "./_module-registry.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { AnyWorkflowDef, WorkflowClient } from "./workflow.ts";
import { workflowNameOf } from "./workflow-names.ts";
import type { WorkflowRunBase, WorkflowRunSnapshot } from "./workflow-run.ts";
import { rejectingWorkflows } from "./workflow-unavailable.ts";

/**
 * What {@link createRunSnapshot} accepts: the shared fields, plus whatever the
 * chosen status requires.
 *
 * The `status`-bearing half is DERIVED from {@link WorkflowRunSnapshot}'s own
 * union, arm by arm, so asking for `status: "completed"` without an `output` is
 * a compile error rather than a fixture that lies — and an arm the snapshot
 * grows is one this accepts without a second edit.
 *
 * @typeParam R - The workflow's return type, when the caller names it.
 *
 * @public
 */
export type RunSnapshotOverrides<R = unknown> = Partial<WorkflowRunBase> &
  (
    | { status?: undefined }
    | (WorkflowRunSnapshot<R> extends infer S
        ? S extends unknown
          ? Omit<S, keyof WorkflowRunBase>
          : never
        : never)
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
  overrides?: RunSnapshotOverrides<R>,
): WorkflowRunSnapshot<R>;
/**
 * Build a {@link WorkflowRunSnapshot} of a run of `workflow`, with `output`
 * TYPED by the def.
 *
 * The def carries `R` — what its body returns, or what its `output` schema
 * declares — so `createRunSnapshot(recap, { status: "completed", output })`
 * checks `output` against it, where the bare form takes whatever `R` the
 * caller names. A fixture whose output stopped matching the body is then a
 * compile error in the spec rather than a page that renders `undefined`.
 *
 * The def names the run too, when it can: `workflow` is the key the def was
 * declared under (`workflowNameOf`, recorded when the agent is lowered — a
 * `virtual:aai/agent` import, `withWorkflows`, `workflowRegistry`), the
 * overrides' `workflow` winning, and `"workflow"` for a def no agent declares.
 *
 * @example
 * ```ts no-check
 * import { recap } from "./shared.ts";
 *
 * const done = createRunSnapshot(recap, {
 *   status: "completed",
 *   output: { headline: "…", points: [] }, // typed by `recap`
 * }); // `workflow` is "recap" once the agent declaring it has been imported
 * ```
 *
 * @public
 */
export function createRunSnapshot<R>(
  workflow: AnyWorkflowDef<R>,
  overrides?: RunSnapshotOverrides<R>,
): WorkflowRunSnapshot<R>;
export function createRunSnapshot<R = unknown>(
  first?: RunSnapshotOverrides<R> | AnyWorkflowDef<R>,
  second?: RunSnapshotOverrides<R>,
): WorkflowRunSnapshot<R> {
  // A def is told from an overrides bag by its `run`: no snapshot field is a
  // function, and every workflow def has one.
  const def = isWorkflowDef(first) ? (first as AnyWorkflowDef<R>) : undefined;
  const overrides: RunSnapshotOverrides<R> =
    def !== undefined ? (second ?? {}) : ((first ?? {}) as RunSnapshotOverrides<R>);
  const base: WorkflowRunBase = {
    runId: overrides.runId ?? DEFAULT_RUN_ID,
    workflow:
      overrides.workflow ??
      (def === undefined ? undefined : workflowNameOf(def)) ??
      DEFAULT_WORKFLOW,
    createdAt: overrides.createdAt ?? DEFAULT_CREATED_AT,
    // Every optional base field the overrides name, so a fixture built with a
    // `label` or a `startedAt` is the snapshot a page would read for it.
    ...omitUndefined({
      key: overrides.key,
      label: overrides.label,
      startedAt: overrides.startedAt,
      settledAt: overrides.settledAt,
    }),
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
