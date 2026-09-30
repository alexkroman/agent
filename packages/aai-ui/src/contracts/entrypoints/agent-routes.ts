// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `agent-routes`.
 *
 * The browser half of `agent({ routes })`: `routeFetch`, one call to the
 * agent's own `/api` routes with `?client=` and the route's `{ error }`;
 * `useRoute`, the polling read over it; `useRouteMutation`, the write with a
 * busy key and the last error; `useClientRuns`, the page half of the SDK's
 * `clientRunsRoutes()` with its `ClientRun` rows (RE-EXPORTED from
 * `@alexkroman1/aai`, so one declaration); and `errorMessage`, the sentence a
 * caught failure is rendered as (re-exported the same way). Qualified
 * `aai-ui:agent-routes`; the server half is the SDK's `routes` field.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type ClientRun,
  type ClientRunStatus,
  type ClientRunsResponse,
  errorMessage,
  type RouteFetchOptions,
  type RouteMethod,
  type RouteMutationRunOptions,
  routeFetch,
  type UseClientRunsOptions,
  type UseClientRunsResult,
  type UseRouteMutationOptions,
  type UseRouteMutationResult,
  type UseRouteOptions,
  type UseRouteResult,
  useClientRuns,
  useRoute,
  useRouteMutation,
} from "../../index.ts";
