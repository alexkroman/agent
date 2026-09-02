// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing`.
 *
 * Driving a DURABLE workflow run from a spec — the real engine over the memory
 * journal, with the driver supplying what a deployment's queue supplies: one
 * delivery at a time, a suspension recorded rather than waited out, a hook
 * answered, a worker killed, and a fresh engine over the same journal.
 *
 * Its own capability rather than part of `eval`, although both are surfaces a
 * TEST imports, because the two make different promises. `eval` drives an agent
 * from text over an engine that is explicitly NOT durable — no journal, no
 * replay, no retry — and its own doc forbids reporting a case there as covering
 * any of the three. This is the opposite claim, and folding them together would
 * mean one epoch for two contracts that move for unrelated reasons.
 *
 * ONE subpath, and deliberately not a `/testing/vitest` sibling: nothing here
 * installs a process-global or owns a lifetime a runner has to unwind, which is
 * this repo's rule for what may stay off a runner-flavoured subpath. The driver
 * injects its own dispatcher, so no timer is ever armed.
 *
 * Re-exported from `@alexkroman1/aai-runtime/testing`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  DEFAULT_MAX_DELIVERIES,
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowTestHandle,
  type WorkflowTestRead,
  type WorkflowTestRun,
  type WorkflowTestStep,
} from "../../testing-barrel.ts";
