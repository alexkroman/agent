// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `agent-routes`.
 *
 * The browser half of `agent({ routes })`: `routeFetch`, one call to the
 * agent's own `/api` routes with `?client=` and the route's `{ error }`, and
 * `useRoute`, the polling read over it. Qualified `aai-ui:agent-routes`; the
 * server half is the SDK's `routes` field.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type RouteFetchOptions,
  type RouteMethod,
  routeFetch,
  type UseRouteOptions,
  type UseRouteResult,
  useRoute,
} from "../../index.ts";
