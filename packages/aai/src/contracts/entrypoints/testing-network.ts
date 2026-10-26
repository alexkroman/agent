// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing-network`.
 *
 * Testing code that makes HTTP requests, without a network: the route table
 * for the global fetch and the step fetch at once (`stubFetchRoutes`), the
 * model-gateway fake (`stubGateway`, `stubGatewayRoute`, and the installer),
 * and the `stepFetch` slot fake (`stubStepFetch`, and its installer).
 *
 * Split off `testing` because these fakes move with the wire — a route key's
 * grammar, the gateway's request shape — rather than with a tool's context.
 * Part of the `testing` family: `aai-runtime`'s `testing-stubs` door mirrors
 * the whole family.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  type FetchRouteHandler,
  type FetchRouteHit,
  type FetchRouteRequest,
  type FetchRoutesOptions,
  type FetchRouteTable,
  // `routeOf(table)` and `routeHandlerOf(answer)`: one handler out of a route
  // table or a canned answer, for a spec that drives the handler directly.
  routeHandlerOf,
  routeOf,
  type StubFetchRoutes,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGatewayRoute,
  type StubStepAnswer,
  type StubStepFetch,
  type StubStepRequest,
  stubFetchRoutes,
  stubGateway,
  stubGatewayRoute,
  stubStepFetch,
} from "../../sdk/testing-barrel.ts";
export {
  type InstallStubGatewayOptions,
  installStubGateway,
  installStubStepFetch,
} from "../../sdk/testing-vitest-barrel.ts";
