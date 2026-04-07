// Copyright 2025 the AAI authors. MIT license.
/**
 * Setup for adversarial tests — reuses the chaos environment
 * with production-matching limits under shared-cpu-2x constraints.
 */

export { type ChaosEnv, DEPLOY_KEY, startChaosEnv } from "../chaos/setup.ts";

/** Slug for the baseline "good" agent used to verify collateral damage. */
export const GOOD_AGENT_SLUG = "good-agent";
