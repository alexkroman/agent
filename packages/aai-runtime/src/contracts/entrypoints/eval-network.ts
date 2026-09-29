// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval-network`.
 *
 * The fake network an eval runs its tools against — `evalNetwork`, its request
 * log and its assertions — which `describeEval` installs as all three fetches a
 * case can reach.
 *
 * Its own capability over `/eval` rather than part of `eval`, for the reason
 * `eval-assert` is: it is new and still moving, and a route key's grammar or a
 * log field changing is not a change to the harness that runs the case. The
 * harness's own option types (`DescribeEvalOptions.network`,
 * `EvalCaseOptions.network`, `EvalTestContext.network`) name `EvalNetwork` and
 * stay `eval`'s; this capability owns the type they name.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract
 * a report for this capability alone, hash it, and hold it to a committed
 * epoch. See `scripts/api-contracts.mjs`.
 */

export {
  type EvalNetwork,
  type EvalNetworkOptions,
  type EvalRequest,
  type EvalRequestFilter,
  type EvalRoute,
  evalNetwork,
} from "../../eval-barrel.ts";
