// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `agent-routes`.
 *
 * The `agent({ routes })` field group and everything written inside it:
 * `AgentRoutes`, what a handler receives (`RouteRequest`, `RouteContext`) and
 * answers (`routeResponse`, `RouteResponse`, the thrown `routeError`), the
 * validated-handler helper (`route`, `RouteDef`, `ValidatedRouteRequest`), the
 * signed-webhook helpers (`webhookRoute`, `verifyStandardWebhook`) and
 * `clientRunsRoutes` with the `ClientRun` rows its routes answer.
 *
 * Split off `agent` when it reached 77 names: a route is a field of the
 * declaration, but the HTTP vocabulary moves for reasons that have nothing to do
 * with declaring a voice agent, and every such move renumbered the flagship
 * contract every template imports. `AgentDef` still extends `AgentRoutes` by
 * name, so adding or dropping the field is visible on `agent`.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AgentRoutes,
  // `apiKeyRoute({ env }, handler)`: the bearer-key sibling of `webhookRoute`.
  type ApiKeyRouteOptions,
  apiKeyRoute,
  type ClientRun,
  type ClientRunStatus,
  type ClientRunsResponse,
  type ClientRunsRoutesOptions,
  clientRunsRoutes,
  type RouteContext,
  type RouteDef,
  RouteError,
  type RouteHandler,
  type RouteRequest,
  type RouteResponse,
  type RouteResponseOptions,
  route,
  routeError,
  routeResponse,
  type StandardWebhookOptions,
  type ValidatedRouteRequest,
  verifyStandardWebhook,
  type WebhookRouteOptions,
  webhookRoute,
} from "../../index.ts";
