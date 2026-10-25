// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link RouteContext} a spec builds to call one `agent({ routes })`
 * handler directly.
 *
 * Its own module for the reason `_testing-context.ts` gives: the builder
 * defaults `workflows` to `createStubWorkflows()`, which `sdk/testing.ts`
 * re-exports, so living in the assembly point would make it import itself.
 * Re-exported from `sdk/testing.ts`; nothing outside this package imports this
 * module by name.
 *
 * @module _testing-route-context
 */

import type { RouteContext } from "./agent-routes.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { createStubWorkflows } from "./testing-workflows.ts";

/**
 * What {@link createRouteContext} accepts: a field per {@link RouteContext}
 * field, each also taking `undefined` for one the caller does not have.
 *
 * @input
 * @public
 */
export type RouteContextOverrides = {
  [K in keyof RouteContext]?: RouteContext[K] | undefined;
};

/**
 * Build a {@link RouteContext} for calling a route handler in isolation.
 *
 * Defaults are inert: an empty `env`, a `workflows` client whose every method
 * rejects naming itself (`createStubWorkflows`), a `clientTranscript` that
 * answers no sessions, a `sessionTranscript` that answers no lines, a `speech`
 * that finds no live session, and a `signal` that never aborts. Override any of
 * them — most specs pass `env` and a `workflows` fake of their own.
 *
 * A hand-built literal has to restate every field, and it is the field the
 * runtime gained LAST that it leaves out: five shipped specs each carried one,
 * and `sessionTranscript` was missing from all five.
 *
 * @example
 * ```ts
 * import { type RouteHandler, type RouteRequest, routeError } from "@alexkroman1/aai";
 * import { createRouteContext, createStubWorkflows } from "@alexkroman1/aai/testing";
 * import { expect, test } from "vitest";
 *
 * const getCall: RouteHandler = async (req, ctx) => {
 *   const [run] = await ctx.workflows.find("call", req.params.id ?? "", { limit: 1 });
 *   if (run === undefined) throw routeError(404, `No call ${req.params.id}.`);
 *   return run;
 * };
 *
 * const request: RouteRequest = {
 *   method: "GET",
 *   path: "/calls/c_1",
 *   params: { id: "c_1" },
 *   query: {},
 *   headers: {},
 *   body: undefined,
 * };
 *
 * test("GET /calls/:id is a 404 for a call nobody placed", async () => {
 *   const workflows = createStubWorkflows({ find: () => Promise.resolve([]) });
 *   const ctx = createRouteContext({ env: { CALLS_API_KEY: "k" }, workflows });
 *   await expect(getCall(request, ctx)).rejects.toMatchObject({ status: 404 });
 * });
 * ```
 *
 * @public
 */
export function createRouteContext(overrides: RouteContextOverrides = {}): RouteContext {
  return {
    env: {},
    workflows: createStubWorkflows(),
    clientTranscript: () => Promise.resolve({ sessions: [] }),
    sessionTranscript: () => Promise.resolve([]),
    speech: () => undefined,
    signal: new AbortController().signal,
    ...omitUndefined(overrides),
  };
}
