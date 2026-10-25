// Copyright 2026 the AAI authors. MIT license.
/**
 * A case's SCRIPTED step HTTP, held and drained by the harness — the
 * `steps` option of `describeEval` / `describeWorkflowEval`.
 *
 * Two shipped evals of a hand-off agent each wrote the same forty lines: a
 * `stubFetchRoutes` over the step fetch only (the session's own model traffic
 * stays live), a `Promise.withResolvers` GATE parking the first answered
 * request so a run is unambiguously still in flight when the caller asks
 * about it, a `release()` the case had to remember, and a `drain()` —
 * `release(); await workflows.settleAll()` — the case had to call LAST,
 * because the fakes are unpublished when the case ends and a body still
 * mid-flight would make its next request against whatever the next case
 * publishes. `EvalWorkflows.close` warns about exactly that leak and says the
 * release is the case's because nothing in the harness could open its gate.
 * Now the harness holds the gate, so it can.
 *
 * What stays the case's is the ROUTES: what the provider answers is the
 * scenario. What moves here is the lifetime — install, hold, release, drain,
 * restore — in the one order that works.
 *
 * @module _case-steps
 */

import {
  type FetchRouteHandler,
  type FetchRouteHit,
  type FetchRouteRequest,
  type FetchRouteTable,
  stubFetchRoutes,
} from "@alexkroman1/aai/testing";
import type { EvalWorkflows } from "./workflows.ts";

/**
 * The `steps` option: the routes a case's step HTTP is answered from, and
 * whether the first answer is HELD.
 *
 * @input
 */
export type EvalStepsOptions = {
  /**
   * What a step's `stepFetch` is answered from — a `stubFetchRoutes` table,
   * or an ordered handler list (how `stubGatewayRoute`'s `route` composes).
   * The STEP fetch only: a live case's own model traffic stays on the global.
   * A request no route answers is a finding and rejects naming it.
   */
  readonly routes: FetchRouteTable | readonly FetchRouteHandler[];
  /**
   * Park the FIRST answered request until the case calls `steps.release()`
   * (or ends), so a run is observably still in flight: a durable `sleep` is
   * skipped in an eval, and an unheld run burns its whole poll loop in
   * milliseconds. `"first"` holds the first request any route answered; a
   * predicate holds the first request it matches (the first `GET`, say).
   * Defaults to `"none"`.
   */
  readonly hold?: "first" | "none" | ((request: FetchRouteRequest) => boolean) | undefined;
  /**
   * Release the gate and `settleAll()` the case's workflow app when the case
   * ends, so no run outlives its routes. Defaults to `true`; `false` for a
   * case that drains by hand or means to leave a run abandoned (the app's
   * `close()` still warns).
   */
  readonly drain?: boolean | undefined;
};

/**
 * What a case is handed as `ctx.steps`.
 *
 * @sealed
 */
export type EvalSteps = {
  /**
   * Every step request as it ARRIVED, in order — a held one included, which is
   * what makes "the run is waiting on the provider" a claim about this list.
   */
  readonly requests: readonly FetchRouteRequest[];
  /**
   * Every step request as it was ANSWERED, with its outcome and status —
   * `stubFetchRoutes`' own log, which records a request once it has resolved,
   * so a held one is not here until released.
   */
  readonly hits: readonly FetchRouteHit[];
  /** Whether a request is parked on the gate right now. */
  readonly held: boolean;
  /** Let the held request answer. Idempotent; the harness calls it at case end. */
  release(): void;
};

/** The harness's handle: the case's view plus what only the harness does. */
export type CaseSteps = EvalSteps & {
  /** Whether to `settleAll()` at case end. */
  readonly drain: boolean;
  /** Unpublish the step fetch. After the drain, never before it. */
  restore(): void;
};

/**
 * Install the case's routes over the step fetch, with the hold wired in.
 *
 * The hold is applied AFTER routing, per handler, so the answer a parked
 * request eventually gets is the one the script owed it, and the log has
 * already counted the request while it is in flight — "the run is waiting on
 * the provider" is a claim about the log.
 */
export function installCaseSteps(options: EvalStepsOptions): CaseSteps {
  const gate = Promise.withResolvers<void>();
  const wants = holdPredicate(options.hold ?? "none");
  let parked = false;
  let held = false;
  const requests: FetchRouteRequest[] = [];
  // By IDENTITY, not against the last entry: two requests in flight at once
  // interleave their handlers, so the second's arrival lands between the
  // first's wrappers and the first would be logged again.
  const arrived = new Set<FetchRouteRequest>();
  const wrap =
    (handler: FetchRouteHandler): FetchRouteHandler =>
    async (request) => {
      // Logged on ARRIVAL, once per request: a list's handlers are tried in
      // order and a table's by specificity, so the same request reaches
      // several wrappers.
      if (!arrived.has(request)) {
        arrived.add(request);
        requests.push(request);
      }
      const answered = await handler(request);
      if (answered !== undefined && !parked && wants(request)) {
        parked = true;
        held = true;
        await gate.promise;
      }
      return answered;
    };
  const net = stubFetchRoutes(wrapRoutes(options.routes, wrap), { globalFetch: false });
  return {
    requests,
    hits: net.hits,
    get held() {
      return held;
    },
    release: () => {
      // Cleared HERE, not when the parked handler resumes: `held` is what a case
      // reads right after `release()`, and the resume is a microtask away.
      held = false;
      gate.resolve();
    },
    drain: options.drain ?? true,
    restore: () => net.restore(),
  };
}

/** Which answered request to park, as a predicate: none, the first, or the first matching. */
function holdPredicate(
  hold: NonNullable<EvalStepsOptions["hold"]>,
): (request: FetchRouteRequest) => boolean {
  if (hold === "none") return () => false;
  if (hold === "first") return () => true;
  return hold;
}

/** Every route wrapped, a table's fixed answers lifted to handlers first. */
function wrapRoutes(
  routes: FetchRouteTable | readonly FetchRouteHandler[],
  wrap: (handler: FetchRouteHandler) => FetchRouteHandler,
): FetchRouteTable | readonly FetchRouteHandler[] {
  if (Array.isArray(routes)) return (routes as readonly FetchRouteHandler[]).map(wrap);
  return Object.fromEntries(
    Object.entries(routes as FetchRouteTable).map(([key, value]) => [
      key,
      wrap(typeof value === "function" ? value : () => value),
    ]),
  );
}

/**
 * Release the gate and wait for the case's runs, at case end.
 *
 * When the BODY already failed, a drain that fails too is swallowed: the
 * body's error is the finding, and a run that then times out while draining
 * is a consequence of it, not a second finding worth replacing it with.
 */
export async function drainCaseSteps(
  steps: CaseSteps,
  workflows: EvalWorkflows | undefined,
  bodyFailed: boolean,
): Promise<void> {
  steps.release();
  if (!steps.drain || workflows === undefined) return;
  if (bodyFailed) {
    await workflows.settleAll().catch(() => undefined);
    return;
  }
  await workflows.settleAll();
}

/**
 * {@link drainCaseSteps} (when there are steps), then `close` WHATEVER the
 * drain did.
 *
 * The drain is the first thing a case's teardown does, and it can reject — a
 * run that never settles times out. Written inline ahead of the closes, that
 * rejection skipped every one of them, and each is a PROCESS-GLOBAL
 * registration or a live runtime handed back nowhere else: the next case then
 * ran over this one's scripted model, step fetch and engine. The drain's error
 * is rethrown once every close has run.
 */
export async function drainThenClose(
  steps: CaseSteps | undefined,
  workflows: EvalWorkflows | undefined,
  bodyFailed: boolean,
  close: () => Promise<void>,
): Promise<void> {
  try {
    if (steps !== undefined) await drainCaseSteps(steps, workflows, bodyFailed);
  } finally {
    await close();
  }
}
