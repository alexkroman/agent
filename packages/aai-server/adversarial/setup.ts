// Copyright 2025 the AAI authors. MIT license.
/**
 * Setup for adversarial tests — reuses the load environment
 * with production-matching limits under shared-cpu-2x constraints.
 */

export { DEPLOY_KEY, type LoadEnv, startLoadEnv } from "../load/setup.ts";

/** Slug for the baseline "good" agent used to verify collateral damage. */
export const GOOD_AGENT_SLUG = "good-agent";
