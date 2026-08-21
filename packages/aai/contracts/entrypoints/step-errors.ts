// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `step-errors`.
 *
 * The failure a `"use step"` body throws, classified so the Workflow DevKit
 * retries what is worth retrying and stops on what is not. Its own capability
 * rather than part of `utils` because it is the one authoring surface that
 * reaches the DevKit's own error classes — which is exactly why it is its own
 * subpath too.
 *
 * Re-exported from `@alexkroman1/aai/step-errors`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  stepFetchOk,
  throwFatalStepError,
  throwStepError,
  toStepError,
} from "../../sdk/step-errors.ts";
