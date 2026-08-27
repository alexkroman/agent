// Copyright 2026 the AAI authors. MIT license.
/**
 * How each Storage method is scoped to ONE agent — the tenant boundary, as a
 * table rather than as eleven decisions spread across a switch.
 *
 * The DevKit's schema has no tenant column (see `workflow-run-owner.ts`), so every
 * call has to be scoped by the platform. Five of its eleven methods are the reason
 * this module exists: their lookup key is not a run id, so passing them through
 * would answer with whatever matched, whoever owned it.
 *
 * | method | key | if unscoped |
 * | --- | --- | --- |
 * | `runs.list` | `workflowName` / `status` only | every tenant's runs |
 * | `steps.get` | `runId` is OPTIONAL | undefined looks up by step id alone |
 * | `events.listByCorrelationId` | a correlation id | not run-scoped at all |
 * | `hooks.get` / `getByToken` | a hook id / a token | not run-scoped at all |
 * | `hooks.list` | `runId` is OPTIONAL | undefined lists every hook |
 *
 * ## The union is CLOSED, and that is the point
 *
 * {@link STORAGE_SCOPES} is a `Record<StorageMethod, StorageScope>`, so a method
 * added to the union without a scope is a compile error rather than a call that
 * quietly reaches the DevKit unscoped. Same shape as `GUEST_ROUTE_EXPOSURE` and
 * for the same reason: the dangerous mistake is forgetting to decide, so the type
 * makes forgetting impossible.
 *
 * ## What it deliberately does NOT do
 *
 * It performs no checks and touches no database. Deciding is separable from
 * enforcing, and separating them is what lets the decision be tested
 * exhaustively — every method, every argument shape — with nothing stood up. The
 * handler above it does the enforcing.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * Every Storage method the platform serves.
 *
 * Dotted names rather than a nested shape, because they are what crosses the wire
 * and a flat literal is what a route can validate in one comparison. The set is
 * the DevKit's `Storage` interface exactly — eleven methods, no more, and adding
 * one is a deliberate act.
 */
export const STORAGE_METHODS = [
  "runs.get",
  "runs.list",
  "steps.get",
  "steps.list",
  "events.create",
  "events.get",
  "events.list",
  "events.listByCorrelationId",
  "hooks.get",
  "hooks.getByToken",
  "hooks.list",
] as const;

export type StorageMethod = (typeof STORAGE_METHODS)[number];

/**
 * How one method is scoped.
 *
 * - `run-arg` — a run id is the Nth positional argument. Refused when absent, which
 *   is what closes `steps.get`'s optional first parameter.
 * - `run-param` — a run id is a NAMED field of the params object at argument N.
 *   Refused when absent, which closes `hooks.list`.
 * - `own-runs` — the call has no run key at all, so it is not forwarded: the
 *   handler answers from this agent's own run ids instead.
 * - `filter-runs` — forwarded, then every result whose run this agent does not own
 *   is dropped. For a lookup key that is legitimately not a run id.
 * - `resolve-hook` — forwarded to fetch the hook, whose `runId` is then the thing
 *   checked. The hook is only returned if that check passes.
 * - `create-run` — the mutation. It may CREATE the run it is scoped by, so
 *   ownership is established rather than verified; see the handler.
 */
export type StorageScope =
  | { kind: "run-arg"; index: number }
  | { kind: "run-param"; index: number; field: string }
  | { kind: "own-runs" }
  | { kind: "filter-runs" }
  | { kind: "resolve-hook" }
  | { kind: "create-run" };

/**
 * The scope of every method, and a compile error for any that lacks one.
 *
 * Each entry records WHY, because the wrong answer here is a cross-tenant read and
 * the right answer is not always the obvious one.
 */
export const STORAGE_SCOPES: Record<StorageMethod, StorageScope> = {
  // The run id is the first argument, and it is required by their signature too.
  "runs.get": { kind: "run-arg", index: 0 },
  // NO run key: their query filters on `workflowName` and `status`, so forwarding
  // it would list every agent's runs. Answered from the owner table instead.
  "runs.list": { kind: "own-runs" },
  // Their first parameter is `string | undefined`, and undefined makes them look a
  // step up by its id alone — across every tenant. Required here.
  "steps.get": { kind: "run-arg", index: 0 },
  "steps.list": { kind: "run-param", index: 0, field: "runId" },
  "events.create": { kind: "create-run" },
  "events.get": { kind: "run-arg", index: 0 },
  "events.list": { kind: "run-param", index: 0, field: "runId" },
  // A correlation id is a USER-CHOSEN key (`createHook({ correlationId })`), so
  // two agents can legitimately pick the same one. It cannot be required to belong
  // to this agent, so the RESULTS are filtered instead.
  "events.listByCorrelationId": { kind: "filter-runs" },
  // A hook id and a token identify a hook, not a run. Both are resolved first and
  // the hook's own `runId` is what gets checked.
  "hooks.get": { kind: "resolve-hook" },
  "hooks.getByToken": { kind: "resolve-hook" },
  // `runId` is optional in their params and absent means every hook. Required.
  "hooks.list": { kind: "run-param", index: 0, field: "runId" },
};

/** Is `value` one of the methods this platform serves? */
export function isStorageMethod(value: unknown): value is StorageMethod {
  return typeof value === "string" && (STORAGE_METHODS as readonly string[]).includes(value);
}

/**
 * What a scoped call needs before it may run.
 *
 * `requiredRunId` is the run whose ownership must hold. `undefined` with
 * `ok: true` means the method carries no run key and the handler's own rule
 * applies (`own-runs`, `filter-runs`, `resolve-hook`, `create-run`).
 */
export type ScopeDecision =
  | { ok: true; scope: StorageScope; requiredRunId?: string }
  | { ok: false; reason: string };

/** The run id at a positional argument, or undefined when there is not one. */
function runIdAt(args: readonly unknown[], index: number): string | undefined {
  const value = args[index];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The run id in a named field of the params object at an argument. */
function runIdIn(args: readonly unknown[], index: number, field: string): string | undefined {
  const params = args[index];
  if (!isRecord(params)) return undefined;
  const value = params[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Decide what this call needs, without checking anything.
 *
 * A missing run id where one is REQUIRED is refused here rather than defaulted,
 * and that is the whole value of the two `run-*` kinds: their signatures make it
 * optional, this makes it mandatory, and the difference is whether an absent
 * argument reads as "look across every tenant".
 *
 * @internal
 */
export function decideScope(method: StorageMethod, args: readonly unknown[]): ScopeDecision {
  const scope = STORAGE_SCOPES[method];
  switch (scope.kind) {
    case "run-arg": {
      const runId = runIdAt(args, scope.index);
      if (runId === undefined) {
        return { ok: false, reason: `${method} requires a run id at argument ${scope.index}` };
      }
      return { ok: true, scope, requiredRunId: runId };
    }
    case "run-param": {
      const runId = runIdIn(args, scope.index, scope.field);
      if (runId === undefined) {
        return { ok: false, reason: `${method} requires ${scope.field} in its params` };
      }
      return { ok: true, scope, requiredRunId: runId };
    }
    default:
      // The four kinds whose rule the handler owns. No run id to require.
      return { ok: true, scope };
  }
}
